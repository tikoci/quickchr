// Minimal listener: decode 4-byte big-endian length-prefixed Ethernet frames (socket_vmnet framing)
// Usage: bun stream-listener.ts <unix-socket-path>
import { unlinkSync } from "node:fs";

const path = process.argv[2];
if (!path) throw new Error("usage: bun stream-listener.ts <unix-socket-path>");
try {
	unlinkSync(path);
} catch {}

const hex = (a: Uint8Array) => [...a].map((x) => x.toString(16).padStart(2, "0")).join(":");
let buf = new Uint8Array(0);
let n = 0;

Bun.listen({
	unix: path,
	socket: {
		open() {
			console.log("client connected");
		},
		data(_s, chunk) {
			const b = new Uint8Array(buf.length + chunk.length);
			b.set(buf);
			b.set(chunk, buf.length);
			buf = b;
			while (buf.length >= 4) {
				const view = new DataView(buf.buffer, buf.byteOffset);
				const len = view.getUint32(0, false);
				if (buf.length < 4 + len) break;
				const f = buf.subarray(4, 4 + len);
				const fv = new DataView(f.buffer, f.byteOffset);
				if (len < 14) {
					console.log(`short Ethernet frame len=${len}`);
				} else {
					const et = fv.getUint16(12, false);
					const isDhcp = len >= 38 && et === 0x0800 && fv.getUint8(23) === 17 && fv.getUint16(36, false) === 67;
					console.log(
						`frame len=${len} dst=${hex(f.subarray(0, 6))} src=${hex(f.subarray(6, 12))} ethertype=0x${et.toString(16)}${isDhcp ? " DHCP-to-server" : ""}`,
					);
				}
				buf = buf.subarray(4 + len);
				if (++n >= 3) process.exit(0);
			}
		},
	},
});
setTimeout(() => {
	console.log("timeout, frames:", n);
	process.exit(1);
}, 40000);
