import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { PassThrough } from "node:stream";
import { createProxyServer, parseAllowedHosts, parseConnectAuthority, isPublicAddress } from "./proxy.mjs";

test("Given server-owned Rusty origins, only pinned HTTPS origins and Cloudflare CONNECT are allowed", () => {
  const allowlist = parseAllowedHosts(JSON.stringify(["https://rusty.example"]));
  assert.deepEqual(parseConnectAuthority("rusty.example:443", allowlist), { hostname: "rusty.example", port: 443 });
  assert.deepEqual(parseConnectAuthority("api.cloudflare.com:443", allowlist), { hostname: "api.cloudflare.com", port: 443 });
  assert.throws(() => parseConnectAuthority("attacker.example:443", allowlist), /not allowlisted/);
  assert.throws(() => parseConnectAuthority("rusty.example:444", allowlist), /port 443/);
  assert.throws(() => parseConnectAuthority("rusty.example:443.evil", allowlist), /invalid CONNECT/);
});

test("Given an allowlisted hostname, reject DNS answers that reach private or reserved networks", () => {
  assert.equal(isPublicAddress("93.184.216.34"), true);
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.4.5", "192.168.1.1", "169.254.1.1", "100.64.0.1", "224.0.0.1", "192.0.2.1", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "2001:db8::1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("Given an allowlisted public origin, CONNECT tunnels bytes; private DNS results fail closed", async t => {
  let upstream;
  let receiveInitial;
  const initial = new Promise(resolve => { receiveInitial = resolve; });
  const server = createProxyServer({
    allowlist: parseAllowedHosts('["https://rusty.example"]'),
    resolve: async host => [{ address: host === "rusty.example" ? "93.184.216.34" : "127.0.0.1", family: 4 }],
    connect: () => {
      upstream = new PassThrough();
      upstream.once("data", chunk => receiveInitial(chunk.toString()));
      process.nextTick(() => upstream.emit("connect"));
      return upstream;
    },
    logger: () => {},
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const allowed = await proxyExchange(port, "CONNECT rusty.example:443 HTTP/1.1\r\nHost: rusty.example:443\r\n\r\nclient-data");
  assert.match(allowed, /^HTTP\/1\.1 200 Connection Established\r\n\r\n/);
  assert.equal(await initial, "client-data");

  const denied = await proxyExchange(port, "CONNECT api.cloudflare.com:443 HTTP/1.1\r\nHost: api.cloudflare.com:443\r\n\r\n");
  assert.match(denied, /^HTTP\/1\.1 403 Forbidden/);
});

function proxyExchange(port, request) {
  return new Promise((resolve, reject) => {
    const client = net.connect(port, "127.0.0.1");
    let output = "";
    client.setTimeout(2_000, () => client.destroy(new Error("proxy response timed out")));
    client.on("error", reject);
    client.on("data", chunk => { output += chunk.toString("latin1"); if (output.includes("\r\n\r\n")) { client.destroy(); resolve(output); } });
    client.on("connect", () => client.write(request));
  });
}

test("Given immutable website job hosts, allow only those hosts and still reject private DNS", async t => {
  const allowlist = parseAllowedHosts('["https://rusty.example"]', '["www.amazon.jobs"]');
  assert.deepEqual(parseConnectAuthority("www.amazon.jobs:443", allowlist), { hostname: "www.amazon.jobs", port: 443 });
  assert.throws(() => parseConnectAuthority("evil.example:443", allowlist), /not allowlisted/);
  assert.throws(() => parseAllowedHosts('["https://rusty.example"]', '["127.0.0.1"]'), /public DNS host/);

  const server = createProxyServer({ allowlist, resolve: async () => [{ address: "10.0.0.2", family: 4 }], logger: () => {} });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const denied = await proxyExchange(server.address().port,
    "CONNECT www.amazon.jobs:443 HTTP/1.1\r\nHost: www.amazon.jobs:443\r\n\r\n");
  assert.match(denied, /^HTTP\/1\.1 403 Forbidden/);
});
