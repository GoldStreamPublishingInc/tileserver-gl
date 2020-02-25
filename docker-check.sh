#!/bin/bash

sudo docker top tileserver-3360;
if [ $? -ne 0 ] ; then exit $?; fi
sudo docker top tileserver-3361;
if [ $? -ne 0 ] ; then exit $?; fi
sudo docker top tileserver-3362;
if [ $? -ne 0 ] ; then exit $?; fi
sudo docker top tileserver-3363;
if [ $? -ne 0 ] ; then exit $?; fi
exit 0;
