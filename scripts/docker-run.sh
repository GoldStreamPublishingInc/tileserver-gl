#!/bin/sh

if [ $# -eq 0 ]; then
	echo "Usage: $0 <port> <data-dir>"
	exit 1
fi

PORT=$1
DATA=$(realpath $2)

docker run --rm -d -v $DATA:/data -p $PORT:8080 --name tileserver-$PORT tileserver
exit $?
