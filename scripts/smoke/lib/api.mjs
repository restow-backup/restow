/**
 * A small cookie-jar aware client for the Restow API, used by the smoke the way
 * the web interface uses it: better-auth sign-in under /api/auth and the
 * session routes under /api/v1. Node's fetch keeps no cookies, so the jar is
 * here. `Origin` is sent on every request because better-auth refuses a
 * state-changing call without one, exactly as it would from a browser.
 */
export class ApiError extends Error {
  constructor(method, path, status, body) {
    super(`${method} ${path} answered ${status}: ${JSON.stringify(body)}`);
    this.name = "ApiError";
    this.method = method;
    this.path = path;
    this.status = status;
    this.body = body;
  }
}

function setCookiePairs(response) {
  const lines = response.headers.getSetCookie?.() ?? [];
  const pairs = [];
  for (const line of lines) {
    const [pair, ...attributes] = line.split(";");
    const at = pair.indexOf("=");
    if (at === -1) {
      continue;
    }
    const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/iu.test(attribute));
    pairs.push({ name: pair.slice(0, at).trim(), value: pair.slice(at + 1).trim(), expired });
  }
  return pairs;
}

export class ApiClient {
  constructor(baseUrl, origin) {
    this.baseUrl = baseUrl.replace(/\/$/u, "");
    this.origin = origin;
    this.cookies = new Map();
    this.tenantId = null;
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  /** The cookies as `{ name, value }` pairs, for handing the session to a browser. */
  cookieList() {
    return [...this.cookies.entries()].map(([name, value]) => ({ name, value }));
  }

  async request(method, path, { body, tenantId, raw, headers: extra } = {}) {
    const headers = { accept: "application/json", origin: this.origin, ...extra };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (this.cookies.size > 0) {
      headers.cookie = this.cookieHeader();
    }
    const tenant = tenantId ?? this.tenantId;
    if (tenant) {
      headers["x-restow-tenant"] = tenant;
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const cookie of setCookiePairs(response)) {
      if (cookie.expired || cookie.value === "") {
        this.cookies.delete(cookie.name);
      } else {
        this.cookies.set(cookie.name, cookie.value);
      }
    }
    if (raw) {
      return response;
    }
    const text = await response.text();
    let parsed = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: response.status, body: parsed, headers: response.headers };
  }

  async expect(method, path, options) {
    const result = await this.request(method, path, options);
    if (result.status >= 400) {
      throw new ApiError(method, path, result.status, result.body);
    }
    return result.body;
  }

  get(path, options) {
    return this.expect("GET", path, options);
  }

  post(path, body, options) {
    return this.expect("POST", path, { ...options, body: body ?? {} });
  }

  put(path, body, options) {
    return this.expect("PUT", path, { ...options, body: body ?? {} });
  }

  patch(path, body, options) {
    return this.expect("PATCH", path, { ...options, body: body ?? {} });
  }

  /** A response body as bytes, for downloads. */
  async download(path, options) {
    const response = await this.request("GET", path, { ...options, raw: true });
    if (response.status >= 400) {
      throw new ApiError("GET", path, response.status, await response.text());
    }
    return Buffer.from(await response.arrayBuffer());
  }
}
