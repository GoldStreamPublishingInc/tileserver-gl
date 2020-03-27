@echo off

docker container stop tileserver-debug
docker run --rm -v %cd%:/data -p 8080:80 -p 9229:9229 --name tileserver-debug tileserver-debug --verbose %*
