import { describe, expect, it } from "vitest"
import { parseServiceLoginRequest, serviceLoginPayload } from "./serviceLogin"
describe("TinSink domain approval", () => {
  const request = { origin:"https://sink.example", challenge:"a".repeat(64), expires_at:1120 }
  const encoded = (r:unknown) => btoa(JSON.stringify(r))
  it("Given an exact service origin, when approving, then signature binds service origin and challenge", () => {
    const parsed = parseServiceLoginRequest(encoded(request), 1000)
    expect(serviceLoginPayload(parsed,1000)).toMatchObject({kind:"tinsink-login", version:2, origin:request.origin, challenge:request.challenge})
  })
  it("Given expired or non-origin requests, when parsing, then approval fails", () => {
    for(const origin of ["https://sink.example/path","https://user:pass@sink.example","http://remote.example","javascript:alert(1)"])
      expect(() => parseServiceLoginRequest(encoded({...request,origin}),1000)).toThrow()
    expect(() => parseServiceLoginRequest(encoded(request),1120)).toThrow()
    expect(() => parseServiceLoginRequest(encoded({...request,expires_at:2000}),1000)).toThrow()
  })
})
