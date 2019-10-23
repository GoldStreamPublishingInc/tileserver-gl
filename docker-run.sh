#!/bin/sh

docker run --rm -d -v `pwd`:/data -p 3359:80 --name tileserver tileserver --verbose
