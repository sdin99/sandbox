$ORACLE_BASE/runOracle.sh > /tmp/debug_oracle.log 2>&1 & sleep 5; kill $!

kill $!
ps pkill -9 -f oracle

tail -f /tmp/debug_oracle.log
less /tmp/debug_oracle.log