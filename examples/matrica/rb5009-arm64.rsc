# feb/25 2025 12:00:00 by RouterOS 7.x
# software id = MATRICA-TEST
#
# model = CHR (ARM64)
# serial number = none
#
# matrica — sample config for parallel version matrix test
# Designed for ARM64 CHR with zerotier + container packages.
#
# Interface layout (with --emulate-device rb5009):
#   ether1 = WAN/management (user-mode networking, hostfwd to host)
#   ether2–ether8 = LAN ports (unconnected socket links, presence only)
#   ether9 = optional uplink
# Without --emulate-device rb5009, only ether1 exists.
# RouterOS logs warnings for missing bridge ports; the router stays stable.
/interface bridge
add comment="matrica LAN bridge" name=bridge1

/interface bridge port
add bridge=bridge1 interface=ether2
add bridge=bridge1 interface=ether3
add bridge=bridge1 interface=ether4
add bridge=bridge1 interface=ether5
add bridge=bridge1 interface=ether6
add bridge=bridge1 interface=ether7
add bridge=bridge1 interface=ether8

/ip dhcp-client
add comment="WAN / management" disabled=no interface=ether1

/ip address
add address=10.88.1.1/24 comment="matrica LAN" interface=bridge1

/ip dhcp-server
add interface=bridge1 lease-time=1h name=dhcp1

/ip dhcp-server network
add address=10.88.1.0/24 dns-server=8.8.8.8 gateway=10.88.1.1

/ip dns
set allow-remote-requests=yes servers=8.8.8.8,8.8.4.4

/ip firewall filter
add action=accept chain=input comment="accept established connections" \
    connection-state=established,related
add action=accept chain=input comment="accept ICMP" protocol=icmp
add action=accept chain=input comment="accept management port" dst-port=80,22 \
    protocol=tcp
add action=drop chain=input comment="drop everything else"

/ip service
set telnet disabled=yes
set ftp disabled=yes
set www-ssl disabled=yes
set api disabled=yes
set api-ssl disabled=yes
set winbox disabled=yes

/system clock
set time-zone-autodetect=no time-zone-name=UTC

/system identity
set name=matrica-chr

/system note
set note="matrica: parallel version matrix test\nzerotier + container packages (ARM64)"
