# netinstall -s: persistent configure script (replaces the default config)
:delay 5s
/ip dhcp-client add interface=ether1
/system identity set name=pxe-configure
