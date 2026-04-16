:foreach v in={(10s,10s500ms);(10s500ms,10s);(11s,10s);(10s,15s);(15s,10s)} do={
    :put " activation-timeout: $($v->0)"
    :put "   duration:\t$($v->1)"
    :local op do={:onerror e in={
        /tool/fetch http-method=post url="http://localhost/rest/system/device-mode/update" http-data=[:serialize to=json {
            "mode"="advanced";
            "activation-timeout"=($v->0);
            "container"=true;"duration"=($v->1);
            "as-value"=true
            }] http-header-field="content-type: application/json" user=admin password=""
        :put "DONE"
        } do={
        :put "-- EXCEPTION -- $e"
        :put "> check REST is okay"
        /tool/fetch http-method=post url="http://localhost/rest/system/device-mode/get" http-data=[:serialize to=json {
                "as-value"=true
            }] http-header-field="content-type: application/json" user=admin password=""
        }
    }
    :local calltime [:time {$op v=$v}] 
    :put "   calltime:\t$calltime"
    :put "\r\n   walltime:\t$[/system/clock/get time]"
}
