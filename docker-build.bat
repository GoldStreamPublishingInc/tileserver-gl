@echo off

docker build -t tileserver-debug --force-rm -f Dockerfile_debug .
