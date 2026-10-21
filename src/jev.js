// Minimal client for TypeSafe's Jev "System One" decision API, called through
// OpenRouter by default (TypeSafe's own API has the same shape).
// POST {baseUrl}/v1/systemone with { model, state, questions } and get back
// typed answers: choice -> { choice, probabilities, confidence },
// noul -> { noul }, score -> { score, probabilities, confidence }.

export class JevClient {
  constructor({ apiKey, model, baseUrl, timeoutMs, disabled = false }) {
    this.apiKey = apiKey;
    this.disabled = disabled;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.backoffUntil = 0;
  }

  get enabled() {
    return !!this.apiKey && !this.disabled;
  }

  async decide(state, questions) {
    if (Date.now() < this.backoffUntil) throw new Error('jev backing off');
    const res = await fetch(`${this.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Minecraft bot' },
      body: JSON.stringify({ model: this.model, state, questions }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 429 || res.status === 529) {
      this.backoffUntil = Date.now() + 5000;
      throw new Error(`jev ${res.status}`);
    }
    if (!res.ok) throw new Error(`jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    return body.answers ?? body; // OpenRouter's decisions API returns answers at the top level
  }
}
