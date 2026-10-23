# Server XHTTP parameters restored from v2.5.4 (61744f3).
def client($email; $vision):
    {id:$uuid, email:$email} + (if $vision then {flow:"xtls-rprx-vision"} else {} end);
def clients($email; $relay_email; $vision):
    [client($email; $vision)] +
    (if $relay_uuid != "" then [client($relay_email; $vision) | .id = $relay_uuid] else [] end);
def reality($family; $sni; $sid):
    {
        tag:("public_" + ($port|tostring) + "_" + $family),
        listen:(if $family == "v4" then $listen4 else "::" end), port:$port, protocol:"vless",
        settings:{clients:clients("vision-"+$family; "relay-vision-"+$family; true),
                  decryption:"none", fallbacks:[{dest:"@xhttp_inner"}]},
        streamSettings:{network:"raw", security:"reality",
            realitySettings:{show:false, dest:($sni+":443"), serverNames:[$sni],
                privateKey:$private_key, publicKey:$public_key, shortIds:$sid, maxTimeDiff:60000},
            sockopt:({tcpFastOpen:true} + (if $family == "v6" then {v6only:true} else {} end))},
        sniffing:{enabled:true, destOverride:["http","tls","quic"], routeOnly:true}
    };
{inbounds:[reality("v4";$sni4;$sid4), reality("v6";$sni6;$sid6), {
    tag:"local_xhttp_stream_up", listen:"@xhttp_inner", protocol:"vless",
    settings:{clients:clients("xhttp-stream-up";"relay-xhttp";false), decryption:"none"},
    streamSettings:{network:"xhttp", security:"none", xhttpSettings:{
        mode:"stream-up", host:"", path:$path, uplinkHTTPMethod:"PUT", noGRPCHeader:true, noSSEHeader:true,
        xPaddingBytes:"100-1000", xPaddingObfsMode:true, xPaddingPlacement:"queryInHeader",
        xPaddingMethod:"tokenish", xPaddingKey:"x_padding", xPaddingHeader:"Referer",
        sessionPlacement:"path", seqPlacement:"path", scStreamUpServerSecs:"20-80",
        xmux:{maxConcurrency:"16-32", cMaxReuseTimes:0, hMaxRequestTimes:"600-900",
              hMaxReusableSecs:"1800-3000", hKeepAlivePeriod:0}
    }},
    sniffing:{enabled:true, destOverride:["http","tls","quic"], routeOnly:true}
}]}
