#!/bin/sh

docker run --rm -d -v `pwd`:/data -p 3360:80 --name tileserver-3360 tileserver --verbose
docker run --rm -d -v `pwd`:/data -p 3361:80 --name tileserver-3361 tileserver --verbose
docker run --rm -d -v `pwd`:/data -p 3362:80 --name tileserver-3362 tileserver --verbose
docker run --rm -d -v `pwd`:/data -p 3363:80 --name tileserver-3363 tileserver --verbose
