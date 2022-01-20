#Build an intermediate image, have to use 12.x.x node since 13.x is not working for bcrypt yet
FROM node:14-alpine as buildImg

RUN apk update
RUN apk --no-cache add gnupg python2 make
RUN apk add --upgrade --no-cache libssl1.1
RUN apk add --no-cache g++

RUN mkdir -p /usr/src/
ENV PATH="$PATH:/usr/src/"

WORKDIR /usr/src/
COPY package.json /usr/src/
COPY package-lock.json /usr/src/

RUN npm install --production --loglevel=warn
COPY . /usr/src/

# Build the production image
FROM node:14-alpine
RUN apk add --upgrade --no-cache libssl1.1

RUN mkdir -p /usr/src/
ENV PATH="$PATH:/usr/src/"
WORKDIR /usr/src/
COPY --from=buildImg /usr/src /usr/src

EXPOSE 3333
CMD ["npm", "start"]
