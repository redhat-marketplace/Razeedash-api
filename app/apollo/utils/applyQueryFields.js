/**
 * Copyright 2020, 2022 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const _ = require('lodash');
const { getGroupConditions, filterChannelsToAllowed, filterSubscriptionsToAllowed } = require('../resolvers/common');
// RBAC Sync
const { ACTIONS, TYPES, CLUSTER_REG_STATES, CLUSTER_STATUS, CLUSTER_IDENTITY_SYNC_STATUS } = require('../models/const');


const loadResourcesWithSearchAndArgs = async({ search, args, context })=>{
  const { models } = context;
  const resourceLimit = args.resourceLimit || 500;
  return await models.Resource.find({
    $and: [
      search,
      _.get(args, 'mongoQueries.resources', {}),
    ],
  }).limit(resourceLimit).lean({virtuals: true, defaults: true });
};


const applyQueryFieldsToClusters = async(clusters, queryFields={}, args, context)=>{
  const { models } = context;
  const { orgId, groupLimit } = args;

  const clusterIds = _.map(clusters, 'cluster_id');
  const now = new Date();

  _.each(clusters, (cluster)=>{
    cluster.name = cluster.name || (cluster.metadata || {}).name || (cluster.registration || {}).name || cluster.clusterId || cluster.id;
    cluster.status = CLUSTER_STATUS.UNKNOWN;
    if (cluster.reg_state === CLUSTER_REG_STATES.REGISTERING || cluster.reg_state === CLUSTER_REG_STATES.PENDING) {
      cluster.status = CLUSTER_STATUS.REGISTERED;
    } else if (cluster.reg_state === CLUSTER_REG_STATES.REGISTERED) {
      if (cluster.updated.getTime() < now.getTime() - 3600000 ) {
        cluster.status = CLUSTER_STATUS.INACTIVE;
      } else {
        cluster.status = CLUSTER_STATUS.ACTIVE;
      }
    }

    // RBAC Sync
    cluster.syncedIdentities = Object.keys(cluster.syncedIdentities).map( x => {
      return {
        id: x,
        syncDate: cluster.syncedIdentities[x].syncDate,
        syncStatus: cluster.syncedIdentities[x].syncStatus,
        syncMessage: cluster.syncedIdentities[x].syncMessage,
      };
    } );
  });

  if(queryFields.resources) {
    const resources = await loadResourcesWithSearchAndArgs({
      search: { cluster_id: { $in: clusterIds } },
      args,
      context,
    });

    await applyQueryFieldsToResources(resources, queryFields.resources, args, context);

    const resourcesByClusterId = _.groupBy(resources, 'cluster_id');
    _.each(clusters, (cluster) => {
      cluster.resources = resourcesByClusterId[cluster.cluster_id] || [];
    });
  }

  if(queryFields.groupObjs || queryFields.groups){
    if(clusterIds.length > 0){
      // [
      //   {groups: [{name: 'tag1'}]},
      //   {groups: [{name: 'tag2'}]},
      // ]
      const groupNames = _.filter(_.uniq(_.map(_.flatten(_.map(clusters, 'groups')), 'name')));
      const groups = await models.Group.find({ org_id: orgId, name: { $in: groupNames } }).limit(groupLimit).lean({ virtuals: true });

      await applyQueryFieldsToGroups(groups, queryFields.groupObjs, args, context);

      const groupsByUuid = _.keyBy(groups, 'uuid');
      _.each(clusters, (cluster)=>{
        const clusterGroupUuids = _.map(cluster.groups, 'uuid');
        cluster.groupObjs = _.filter(_.pick(groupsByUuid, clusterGroupUuids));
        cluster.groups = _.filter(_.pick(groupsByUuid, clusterGroupUuids));
      });
    }
  }
};

const applyQueryFieldsToGroups = async(groups, queryFields={}, args, context)=>{
  const { me, models } = context;
  const { orgId } = args;

  if(queryFields.owner){
    const owners = await models.User.getBasicUsersByIds(_.uniq(_.map(groups, 'owner')));
    _.each(groups, (group)=>{
      group.owner = owners[group.owner] || owners.undefined;
    });
  }
  if(queryFields.subscriptions || queryFields.subscriptionCount){
    const groupNames = _.uniq(_.map(groups, 'name'));
    let subscriptions = await models.Subscription.find({ org_id: orgId, groups: { $in: groupNames } }).lean({ virtuals: true });
    subscriptions = await filterSubscriptionsToAllowed(me, orgId, ACTIONS.READ, TYPES.SUBSCRIPTION, subscriptions, context);

    await applyQueryFieldsToSubscriptions(subscriptions, queryFields.subscriptions, args, context);

    const subscriptionsByGroupName = {};
    _.each(subscriptions, (sub)=>{
      if(_.isUndefined(sub.channelName)){
        sub.channelName = sub.channel;
      }
      delete sub.channel; // can not render channel, too deep
      _.each(sub.groups, (groupName)=>{
        subscriptionsByGroupName[groupName] = subscriptionsByGroupName[groupName] || [];
        subscriptionsByGroupName[groupName].push(sub);
      });
    });
    _.each(groups, (group)=>{
      group.subscriptions = subscriptionsByGroupName[group.name] || [];
      group.subscriptionCount = group.subscriptions.length;
    });
  }
  if(queryFields.clusters || queryFields.clusterCount){
    const groupUuids = _.uniq(_.map(groups, 'uuid'));
    const clusters = await models.Cluster.find({ org_id: orgId, 'groups.uuid': { $in: groupUuids } }).lean({ virtuals: true });

    await applyQueryFieldsToClusters(clusters, queryFields.clusters, args, context);

    const clustersByGroupUuid = {};
    _.each(clusters, (cluster)=>{
      _.each(cluster.groups || [], (groupObj)=>{
        clustersByGroupUuid[groupObj.uuid] = clustersByGroupUuid[groupObj.uuid] || [];
        clustersByGroupUuid[groupObj.uuid].push(cluster);
      });
    });
    _.each(groups, (group)=>{
      group.clusters = clustersByGroupUuid[group.uuid] || [];
      group.clusterCount = group.clusters.length;
    });
  }
};

const applyQueryFieldsToResources = async(resources, queryFields={}, args, context)=>{
  const { me, models } = context;
  const { orgId, subscriptionsLimit = 500 } = args;

  if(queryFields.cluster){
    const clusterIds = _.map(resources, 'clusterId');
    const clusters = await models.Cluster.find({ cluster_id: { $in: clusterIds } }).lean({ virtuals: true });

    await applyQueryFieldsToClusters(clusters, queryFields.cluster, args, context);

    const clustersById = _.keyBy(clusters, 'clusterId');
    _.each(resources, (resource)=>{
      resource.cluster = clustersById[resource.clusterId];
    });
  }

  if(queryFields.subscription){
    const subscriptionUuids = _.filter(_.uniq(_.map(resources, 'searchableData.subscription_id')));
    let subscriptions = await models.Subscription.find({ uuid: { $in: subscriptionUuids } }).limit(subscriptionsLimit).lean({ virtuals: true });
    subscriptions = await filterSubscriptionsToAllowed(me, orgId, ACTIONS.READ, TYPES.SUBSCRIPTION, subscriptions, context);

    await applyQueryFieldsToSubscriptions(subscriptions, queryFields.subscription, args, context);

    _.each(subscriptions, (sub)=>{
      if(_.isUndefined(sub.channelName)){
        sub.channelName = sub.channel;
      }
    });
    const subscriptionsByUuid = _.keyBy(subscriptions, 'uuid');
    _.each(resources, (resource)=>{
      const subId = resource.searchableData.subscription_id;
      if(!subId){
        return;
      }
      resource.subscription = subscriptionsByUuid[subId] || null;
      if(resource.subscription) {
        delete resource.subscription.channel;
      }
    });
  }
};

const applyQueryFieldsToDeployableVersions = async(versions, queryFields={}, args, context)=> { // eslint-disable-line
  const { models } = context;

  if(queryFields.owner){
    const owners = await models.User.getBasicUsersByIds(_.filter(_.uniq(_.map(versions, 'ownerId'))));
    _.each(versions, (version)=>{
      version.owner = owners[version.ownerId] || version.undefined;
    });
  }
};

const applyQueryFieldsToChannels = async(channels, queryFields={}, args, context)=>{ // eslint-disable-line
  const { models, me } = context;
  const { orgId } = args;

  if(queryFields.owner){
    const owners = await models.User.getBasicUsersByIds(_.filter(_.uniq(_.map(channels, 'ownerId'))));
    _.each(channels, (channel)=>{
      channel.owner = owners[channel.ownerId] || channel.undefined;
    });
  }

  _.each(channels, (channel)=>{
    if(!channel.tags){
      channel.tags = [];
    }
  });

  if(queryFields.subscriptions){
    //piggyback basic-info of subscriptions associated with this channel that user allowed to see
    const conditions = await getGroupConditions(me, orgId, ACTIONS.READ, 'name', 'applyQueryFieldsToChannels queryFields.subscriptions', context);
    const channelUuids = _.uniq(_.map(channels, 'uuid'));
    let subscriptions = await models.Subscription.find({ org_id: orgId, channel_uuid: { $in: channelUuids }, ...conditions }, {}).lean({ virtuals: true });
    subscriptions = await filterSubscriptionsToAllowed(me, orgId, ACTIONS.READ, TYPES.SUBSCRIPTION, subscriptions, context);

    await applyQueryFieldsToSubscriptions(subscriptions, queryFields.subscriptions, args, context);

    const subscriptionsByChannelUuid = _.groupBy(subscriptions, 'channel_uuid');
    _.each(channels, (channel)=>{
      channel.subscriptions = subscriptionsByChannelUuid[channel.uuid] || [];
    });
  }
};

const applyQueryFieldsToSubscriptions = async(subs, queryFields={}, args, context)=>{ // eslint-disable-line
  const { me, models } = context;
  const { orgId, servSub } = args;

  // Get owner information if users ask for owner or identity sync status
  if( queryFields.owner || queryFields.identitySyncStatus ) {
    const ownerIds = _.map(subs, 'owner');
    const owners = await models.User.getBasicUsersByIds(ownerIds);

    subs = subs.map((sub)=>{
      if(_.isUndefined(sub.channelName)){
        sub.channelName = sub.channel;
      }
      sub.owner = owners[sub.owner];
      return sub;
    });
  }

  _.each(subs, (sub)=>{
    if(_.isUndefined(sub.channelName)){
      sub.channelName = sub.channel;
    }
    delete sub.channel;
  });
  const subUuids = _.uniq(_.map(subs, 'uuid'));

  if(queryFields.cluster) {
    const clusterIds = _.map(subs, 'clusterId');
    const clusters = await models.Cluster.getClustersByIds(clusterIds);
    /*
    Clusters from `getClustersByIds` are BasicClusters and could exist in a different org than the serviceSubscription.
    Filtering to those allowed by the serviceSubscription org would be inappropriate.
    */
    _.each(subs, (sub)=>{
      sub.cluster = clusters[sub.clusterId];
    });
  }

  if(queryFields.channel){
    const channelUuids = _.uniq(_.map(subs, 'channelUuid'));
    let channels = await models.Channel.find({ uuid: { $in: channelUuids } }).lean({ virtuals: true });
    channels = await filterChannelsToAllowed(me, orgId, ACTIONS.READ, TYPES.CHANNEL, channels, context);

    await applyQueryFieldsToChannels(channels, queryFields.channel, args, context);

    const channelsByUuid = _.keyBy(channels, 'uuid');
    _.each(subs, (sub)=>{
      const channelUuid = sub.channelUuid;
      const channel = channelsByUuid[channelUuid];
      sub.channel = channel;
    });
  }

  if(queryFields.resources){
    const search = { org_id: orgId, 'searchableData.subscription_id': { $in: subUuids } };
    if (servSub) delete search.org_id; // service subscriptions push resources to different orgs
    const resources = await loadResourcesWithSearchAndArgs({
      search,
      args,
      context,
    });

    await applyQueryFieldsToResources(resources, queryFields.resources, args, context);

    const resourcesBySubUuid = _.groupBy(resources, 'searchableData.subscription_id');
    _.each(subs, (sub)=>{
      sub.resources = resourcesBySubUuid[sub.uuid] || [];
    });
  }

  if(queryFields.groupObjs){
    const groupNames = _.flatten(_.map(subs, 'groups'));
    const groups = await models.Group.find({ org_id: orgId, name: { $in: groupNames } }).lean({ virtuals: true });

    await applyQueryFieldsToGroups(groups, queryFields.groupObjs, args, context);

    const groupsByName = _.keyBy(groups, 'name');
    _.each(subs, (sub)=>{
      sub.groupObjs = _.filter(_.map(sub.groups, (groupName)=>{
        return groupsByName[groupName];
      }));
    });
  }

  if(queryFields.remoteResources || queryFields.rolloutStatus){
    const search = {
      org_id: orgId,
      'searchableData.annotations["deploy_razee_io_clustersubscription"]': { $in: subUuids },
      deleted: false
    };
    if (servSub) delete search.org_id; // service subscriptions push resources to different orgs
    const remoteResources = await loadResourcesWithSearchAndArgs({
      search,
      args,
      context,
    });

    await applyQueryFieldsToResources(remoteResources, queryFields.remoteResources, args, context);

    const remoteResourcesBySubUuid = _.groupBy(remoteResources, (rr)=>{
      return _.get(rr, 'searchableData[\'annotations["deploy_razee_io_clustersubscription"]\']');
    });
    _.each(subs, (sub)=>{
      const rrs = remoteResourcesBySubUuid[sub.uuid] || [];

      // loops through each resource. if there are errors, increments the errorCount. if no errors, increments successfulCount
      let errorCount = 0;
      let successCount = 0;
      _.each(rrs, (rr)=>{
        const errors = _.toArray(_.get(rr, 'searchableData.errors',[]));
        if(errors.length > 0){
          errorCount += 1;
        }
        else{
          successCount += 1;
        }
      });

      sub.remoteResources = rrs;
      sub.rolloutStatus = {
        successCount,
        errorCount,
      };
    });
  }

  // RBAC Sync
  /*
  Identity Sync Status could also be obtained in theory by querying:
    `groups { clusters { syncedIdentities { syncStatus } } }`
  But that would be inefficient, and require iteration over the results
  while avoiding duplicates to get totals.
  */
  if( queryFields.identitySyncStatus ){
    for( const sub of subs ) {
      sub.identitySyncStatus = {
        unknownCount: 0,
        syncedCount: 0,
        failedCount: 0,
        pendingCount: 0,
      };

      const clusters = await models.Cluster.find({ org_id: orgId, 'groups.name': { $in: sub.groups } }).lean({ virtuals: true });
      for( const c of clusters ) {
        if( c.syncedIdentities && c.syncedIdentities[sub.owner.id] && c.syncedIdentities[sub.owner.id].syncStatus === CLUSTER_IDENTITY_SYNC_STATUS.SYNCED ) {
          sub.identitySyncStatus.syncedCount++;
        }
        else if( c.syncedIdentities && c.syncedIdentities[sub.owner.id] && c.syncedIdentities[sub.owner.id].syncStatus === CLUSTER_IDENTITY_SYNC_STATUS.FAILED ) {
          sub.identitySyncStatus.failedCount++;
        }
        else if( c.syncedIdentities && c.syncedIdentities[sub.owner.id] && c.syncedIdentities[sub.owner.id].syncStatus === CLUSTER_IDENTITY_SYNC_STATUS.PENDING ) {
          sub.identitySyncStatus.pendingCount++;
        }
        else {
          sub.identitySyncStatus.unknownCount++;
        }
      }
    }
  }
};

module.exports = {
  applyQueryFieldsToChannels,
  applyQueryFieldsToClusters,
  applyQueryFieldsToGroups,
  applyQueryFieldsToResources,
  applyQueryFieldsToSubscriptions,
  applyQueryFieldsToDeployableVersions,
};
