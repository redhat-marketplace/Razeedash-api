#!/bin/bash

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

RAZEE_CLUSTER_UUID=${1:-${RAZEE_CLUSTER_UUID:-pClusterId}}
RAZEE_GROUP_UUID=${2:-${RAZEE_GROUP_UUID:-pGroupId}}
RAZEE_ORG_ID=${3:-${RAZEE_ORG_ID:-pOrgId}}

RAZEE_QUERY='mutation($orgId: String!, $groupUuids: [String!]!, $clusterIds: [String!]!){ assignClusterGroups( orgId: $orgId, groupUuids: $groupUuids, clusterIds: $clusterIds ) { modified } }'
RAZEE_VARIABLES='{"orgId":"'"${RAZEE_ORG_ID}"'","groupUuids":["'"${RAZEE_GROUP_UUID}"'"],"clusterIds":["'"${RAZEE_CLUSTER_UUID}"'"]}'

echo "" && echo "ADD Cluster to Group"
${SCRIPT_DIR}/graphqlPost.sh "${RAZEE_QUERY}" "${RAZEE_VARIABLES}"
echo "" && echo "Result: $?"
