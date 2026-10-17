import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import net from "node:net";
import { pathToFileURL } from "node:url";

const cloudflareHost = "api.cloudflare.com";
const maxHeaderBytes = 8_192;
const maxConnections = 128;

export function parseAllowedHosts(value, jobUrlHosts = "[]") {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 16_384) {
    throw new TypeError("REACTION_RUSTY_ORIGINS is required and must be bounded JSON");
  }
  const origins = JSON.parse(value);
  if (!Array.isArray(origins) || origins.length > 16 || origins.some(origin => typeof origin !== "string")) {
    throw new TypeError("REACTION_RUSTY_ORIGINS must be an array of HTTPS origins");
  }
  const hosts = new Set([cloudflareHost]);
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.port && url.port !== "443" ||
      url.pathname !== "/" || url.search || url.hash || isIP(url.hostname)) {
      throw new TypeError("Rusty egress entries must be bare public HTTPS origins");
    }
    hosts.add(url.hostname.toLowerCase());
  }
  if (typeof jobUrlHosts !== "string" || Buffer.byteLength(jobUrlHosts, "utf8") > 4_096) {
    throw new TypeError("REACTION_JOB_URL_HOSTS must be bounded JSON");
  }
  const jobHosts = JSON.parse(jobUrlHosts);
  if (!Array.isArray(jobHosts) || jobHosts.length > 3 || jobHosts.some(host => typeof host !== "string")) {
    throw new TypeError("REACTION_JOB_URL_HOSTS must contain at most three public DNS hosts");
  }
  for (const host of jobHosts) {
    if (host.length > 253 || isIP(host) || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host)) {
      throw new TypeError("REACTION_JOB_URL_HOSTS entries must be public DNS hostnames");
    }
    const normalized = host.toLowerCase();
    if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local") ||
      normalized.endsWith(".internal") || normalized === "metadata.google.internal") {
      throw new TypeError("REACTION_JOB_URL_HOSTS entries must be public DNS hostnames");
    }
    hosts.add(normalized);
  }
  return hosts;
}

export function parseConnectAuthority(authority, allowlist) {
  if (typeof authority !== "string" || authority.length > 320 || /[\s/@?#]/.test(authority)) {
    throw new TypeError("invalid CONNECT authority");
  }
  const match = /^([a-zA-Z0-9.-]+):([0-9]{1,5})$/.exec(authority);
  if (!match) throw new TypeError("invalid CONNECT authority");
  const hostname = match[1].toLowerCase();
  const port = Number(match[2]);
  if (!allowlist.has(hostname)) throw new TypeError("CONNECT destination is not allowlisted");
  if (port !== 443) throw new TypeError("CONNECT is allowed only on port 443");
  return { hostname, port };
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const bytes = address.split(".").map(Number);
    const blocked = [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
      ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
      ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
    ];
    return !blocked.some(([network, prefix]) => inPrefix(bytes, network.split(".").map(Number), prefix));
  }
  if (family !== 6 || address.includes("%")) return false;
  const bytes = ipv6Bytes(address);
  if (!bytes) return false;
  if (bytes.slice(0, 12).every(byte => byte === 0) && bytes[12] === 0 && bytes[13] === 0 && bytes[14] === 0 && bytes[15] === 1) return false;
  if (bytes.slice(0, 12).every(byte => byte === 0) && bytes[12] === 0 && bytes[13] === 0 && bytes[14] === 0 && bytes[15] === 0) return false;
  if (bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPublicAddress(bytes.slice(12).join("."));
  }
  return ![["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["2001:db8::", 32],
    ["2001::", 23], ["2002::", 16]].some(([network, prefix]) => inPrefix(bytes, ipv6Bytes(network), prefix));
}

function inPrefix(bytes, networkBytes, prefix) {
  if (!networkBytes || bytes.length !== networkBytes.length) return false;
  const whole = Math.floor(prefix / 8);
  const remaining = prefix % 8;
  for (let index = 0; index < whole; index += 1) if (bytes[index] !== networkBytes[index]) return false;
  if (remaining) {
    const mask = 0xff << (8 - remaining) & 0xff;
    if ((bytes[whole] & mask) !== (networkBytes[whole] & mask)) return false;
  }
  return true;
}

function ipv6Bytes(address) {
  if (address.includes(".")) {
    const lastColon = address.lastIndexOf(":");
    const ipv4 = address.slice(lastColon + 1).split(".").map(Number);
    if (ipv4.length !== 4 || ipv4.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return null;
    address = `${address.slice(0, lastColon + 1)}${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const parseSide = side => side ? side.split(":").map(part => Number.parseInt(part, 16)) : [];
  const left = parseSide(halves[0]);
  const right = parseSide(halves[1] ?? "");
  if (left.some(value => !Number.isInteger(value) || value < 0 || value > 0xffff) ||
    right.some(value => !Number.isInteger(value) || value < 0 || value > 0xffff)) return null;
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && missing !== 0 || halves.length === 2 && missing < 1) return null;
  const words = [...left, ...Array(Math.max(0, missing)).fill(0), ...right];
  if (words.length !== 8) return null;
  return words.flatMap(word => [word >> 8, word & 0xff]);
}

export function createProxyServer({ allowlist, resolve = lookup, connect = net.connect, logger = console.error }) {
  let active = 0;
  return net.createServer(client => {
    active += 1;
    if (active > maxConnections) {
      client.end("HTTP/1.1 503 Proxy capacity exceeded\r\nConnection: close\r\n\r\n");
      active -= 1;
      return;
    }
    client.once("close", () => { active -= 1; });
    client.setTimeout(30_000, () => client.destroy());
    let header = Buffer.alloc(0);
    let connecting = false;
    client.on("data", async chunk => {
      if (connecting) return;
      header = Buffer.concat([header, chunk]);
      if (header.byteLength > maxHeaderBytes) {
        client.end("HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n");
        return;
      }
      const end = header.indexOf("\r\n\r\n");
      if (end < 0) return;
      connecting = true;
      client.pause();
      const initial = header.subarray(end + 4);
      const firstLine = header.subarray(0, end).toString("latin1").split("\r\n", 1)[0];
      try {
        const match = /^CONNECT ([^ ]+) HTTP\/1\.[01]$/.exec(firstLine);
        if (!match) throw new TypeError("only CONNECT requests are accepted");
        const destination = parseConnectAuthority(match[1], allowlist);
        const addresses = await resolve(destination.hostname, { all: true, verbatim: true });
        if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
          throw new TypeError("CONNECT destination resolved to a non-public address");
        }
        if (client.destroyed) return;
        const address = addresses[0];
        const upstream = connect({ host: address.address, family: address.family, port: destination.port });
        const fail = error => {
          logger(JSON.stringify({ event: "reaction-proxy.connect-failed", host: destination.hostname,
            error: error instanceof Error ? error.message.slice(0, 256) : "connect failed" }));
          if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        };
        upstream.once("error", fail);
        upstream.once("connect", () => {
          if (client.destroyed) { upstream.destroy(); return; }
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (initial.length) upstream.write(initial);
          client.pipe(upstream);
          upstream.pipe(client);
          client.resume();
        });
        client.once("close", () => upstream.destroy());
      } catch (error) {
        logger(JSON.stringify({ event: "reaction-proxy.request-denied", error: error instanceof Error ? error.message : "request denied" }));
        if (!client.destroyed) client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      }
    });
  });
}

function main() {
  const allowlist = parseAllowedHosts(process.env.REACTION_RUSTY_ORIGINS, process.env.REACTION_JOB_URL_HOSTS ?? "[]");
  const port = Number(process.env.REACTION_PROXY_PORT ?? 3128);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new TypeError("REACTION_PROXY_PORT is invalid");
  const server = createProxyServer({ allowlist });
  server.listen(port, "0.0.0.0", () => process.stderr.write(`reaction egress proxy listening on ${port}\n`));
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
