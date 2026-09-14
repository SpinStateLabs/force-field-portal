import { describe, it, expect, afterEach } from "vitest";
import {
  StripeError,
  createCheckoutSession,
  createPortalSession,
  encodeForm,
  parseSignatureHeader,
  signPayload,
  stripeConfig,
  subscriptionPeriodEnd,
  subscriptionPriceId,
  tierForPrice,
  verifyStripeSignature,
} from "../src/lib/stripe";

const CFG = { secret_key: "sk_test_x", webhook_secret: "whsec_test", prices: { operator: "price_op", sovereign: "price_sov" } };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("stripe webhook signature", () => {
  const body = '{"id":"evt_1","type":"x"}';

  it("accepts a valid v1 signature within tolerance", () => {
    const h = signPayload(body, "whsec_test", 1000);
    expect(verifyStripeSignature(body, h, "whsec_test", 1100)).toBe(true);
  });

  it("rejects a wrong secret", () => {
    const h = signPayload(body, "whsec_other", 1000);
    expect(verifyStripeSignature(body, h, "whsec_test", 1100)).toBe(false);
  });

  it("rejects a tampered body", () => {
    const h = signPayload(body, "whsec_test", 1000);
    expect(verifyStripeSignature(body + " ", h, "whsec_test", 1100)).toBe(false);
  });

  it("rejects timestamps outside the tolerance (replay)", () => {
    const h = signPayload(body, "whsec_test", 1000);
    expect(verifyStripeSignature(body, h, "whsec_test", 1000 + 301)).toBe(false);
    expect(verifyStripeSignature(body, h, "whsec_test", 1000 + 300)).toBe(true);
  });

  it("rejects malformed headers", () => {
    expect(verifyStripeSignature(body, null, "whsec_test", 1000)).toBe(false);
    expect(verifyStripeSignature(body, "", "whsec_test", 1000)).toBe(false);
    expect(verifyStripeSignature(body, "t=abc,v1=00", "whsec_test", 1000)).toBe(false);
    expect(verifyStripeSignature(body, "v1=00", "whsec_test", 1000)).toBe(false);
    expect(verifyStripeSignature(body, "t=1000", "whsec_test", 1000)).toBe(false);
  });

  it("ignores v0 and accepts when one of several v1 signatures matches (secret roll)", () => {
    const good = signPayload(body, "whsec_test", 1000).split("v1=")[1];
    const header = `t=1000,v1=${"ab".repeat(32)},v1=${good},v0=zz`;
    expect(verifyStripeSignature(body, header, "whsec_test", 1000)).toBe(true);
    expect(parseSignatureHeader(header)?.v1.length).toBe(2);
  });
});

describe("checkout and portal sessions", () => {
  it("creates a subscription Checkout Session with the tier's price and the user's identity", async () => {
    const calls: { url: string; init: any }[] = [];
    const fetchImpl = async (url: string, init?: any) => {
      calls.push({ url, init });
      return jsonResponse(200, { id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" });
    };
    const r = await createCheckoutSession(
      CFG,
      { user_id: "u1", email: "a@b.co", tier: "operator", success_url: "https://p/ok", cancel_url: "https://p/no" },
      fetchImpl,
    );
    expect(r).toEqual({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" });
    expect(calls[0].url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(calls[0].init.headers.authorization).toBe("Bearer sk_test_x");
    const p = new URLSearchParams(String(calls[0].init.body));
    expect(p.get("mode")).toBe("subscription");
    expect(p.get("line_items[0][price]")).toBe("price_op");
    expect(p.get("line_items[0][quantity]")).toBe("1");
    expect(p.get("client_reference_id")).toBe("u1");
    expect(p.get("customer_email")).toBe("a@b.co");
    expect(p.get("customer")).toBeNull();
    expect(p.get("metadata[user_id]")).toBe("u1");
    expect(p.get("metadata[tier]")).toBe("operator");
    expect(p.get("subscription_data[metadata][user_id]")).toBe("u1");
    expect(p.get("success_url")).toBe("https://p/ok");
  });

  it("reuses an existing Stripe customer instead of the email", async () => {
    let body = "";
    const fetchImpl = async (_url: string, init?: any) => {
      body = String(init.body);
      return jsonResponse(200, { id: "cs_2", url: "https://checkout.stripe.com/c/cs_2" });
    };
    await createCheckoutSession(
      CFG,
      { user_id: "u1", email: "a@b.co", customer_id: "cus_9", tier: "sovereign", success_url: "https://p/ok", cancel_url: "https://p/no" },
      fetchImpl,
    );
    const p = new URLSearchParams(body);
    expect(p.get("customer")).toBe("cus_9");
    expect(p.get("customer_email")).toBeNull();
    expect(p.get("line_items[0][price]")).toBe("price_sov");
  });

  it("maps a Stripe error body to StripeError with its code", async () => {
    const fetchImpl = async () => jsonResponse(402, { error: { code: "card_declined", message: "Your card was declined." } });
    await expect(
      createCheckoutSession(CFG, { user_id: "u1", email: "a@b.co", tier: "operator", success_url: "s", cancel_url: "c" }, fetchImpl),
    ).rejects.toMatchObject({ status: 402, code: "card_declined" });
  });

  it("rejects a session without a URL", async () => {
    const fetchImpl = async () => jsonResponse(200, { id: "cs_3" });
    await expect(
      createCheckoutSession(CFG, { user_id: "u1", email: "a@b.co", tier: "operator", success_url: "s", cancel_url: "c" }, fetchImpl),
    ).rejects.toBeInstanceOf(StripeError);
  });

  it("creates a Customer Portal session for the customer", async () => {
    let seen: { url: string; body: string } | null = null;
    const fetchImpl = async (url: string, init?: any) => {
      seen = { url, body: String(init.body) };
      return jsonResponse(200, { url: "https://billing.stripe.com/p/x" });
    };
    const r = await createPortalSession(CFG, "cus_1", "https://p/app.html", fetchImpl);
    expect(r.url).toBe("https://billing.stripe.com/p/x");
    expect(seen!.url).toBe("https://api.stripe.com/v1/billing_portal/sessions");
    const p = new URLSearchParams(seen!.body);
    expect(p.get("customer")).toBe("cus_1");
    expect(p.get("return_url")).toBe("https://p/app.html");
  });
});

describe("config and helpers", () => {
  const names = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_OPERATOR", "STRIPE_PRICE_SOVEREIGN"];
  afterEach(() => {
    for (const n of names) delete process.env[n];
  });

  it("is unconfigured unless all four variables are set", () => {
    expect(stripeConfig()).toBeNull();
    process.env.STRIPE_SECRET_KEY = "sk";
    process.env.STRIPE_WEBHOOK_SECRET = "wh";
    process.env.STRIPE_PRICE_OPERATOR = "po";
    expect(stripeConfig()).toBeNull();
    process.env.STRIPE_PRICE_SOVEREIGN = "ps";
    expect(stripeConfig()).toEqual({ secret_key: "sk", webhook_secret: "wh", prices: { operator: "po", sovereign: "ps" } });
  });

  it("maps prices to tiers and nothing else", () => {
    expect(tierForPrice(CFG, "price_op")).toBe("operator");
    expect(tierForPrice(CFG, "price_sov")).toBe("sovereign");
    expect(tierForPrice(CFG, "price_other")).toBeNull();
    expect(tierForPrice(CFG, null)).toBeNull();
  });

  it("reads the price id and the period end from either API shape", () => {
    const legacy: any = { id: "s", status: "active", customer: "c", current_period_end: 100, items: { data: [{ price: { id: "price_op" } }] } };
    const modern: any = { id: "s", status: "active", customer: "c", items: { data: [{ price: { id: "price_sov" }, current_period_end: 200 }] } };
    expect(subscriptionPriceId(legacy)).toBe("price_op");
    expect(subscriptionPeriodEnd(legacy)).toBe(100);
    expect(subscriptionPriceId(modern)).toBe("price_sov");
    expect(subscriptionPeriodEnd(modern)).toBe(200);
    expect(subscriptionPeriodEnd({ id: "s", status: "active", customer: "c" })).toBeNull();
  });

  it("form-encodes nested keys literally and skips undefined", () => {
    expect(encodeForm({ a: 1, "b[c]": "x y", d: undefined })).toBe("a=1&b%5Bc%5D=x%20y");
  });
});
