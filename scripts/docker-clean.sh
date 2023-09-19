#!/bin/bash

docker container stop tileserver-3360
docker container stop tileserver-3361
docker container stop tileserver-3362
docker container stop tileserver-3363

docker rm $(docker ps -a -q)
docker rmi $(docker images -q) --force
