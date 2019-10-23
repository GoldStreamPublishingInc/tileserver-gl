FROM node:6.15.1-stretch
MAINTAINER Petr Sloup <petr.sloup@klokantech.com>

ENV NODE_ENV="production"
VOLUME /data
WORKDIR /data
EXPOSE 80
ENTRYPOINT ["/bin/bash", "/usr/src/app/run.sh"]

RUN apt-get -qq update \
&& DEBIAN_FRONTEND=noninteractive apt-get -y install \
    apt-transport-https \
    curl \
    zip \
    unzip \
    build-essential \
    python \
    libcairo2-dev \
    libgles2-mesa-dev \
    libgbm-dev \
    libllvm3.9 \
    libprotobuf-dev \
    libxxf86vm-dev \
    xvfb \
    x11-utils \
    dos2unix \
&& apt-get clean

RUN mkdir -p /usr/src/app
COPY / /usr/src/app
RUN dos2unix /usr/src/app/run.sh
RUN cd /usr/src/app && npm install --production
