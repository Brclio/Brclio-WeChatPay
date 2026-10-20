// External-DNS Pages domain gateway. All payment logic and secrets stay in the Worker.
export default {
  async fetch(request, env) {
    if (!env.PAYMENT_CENTER) return new Response('Payment service is not configured', {status:503});
    return env.PAYMENT_CENTER.fetch(request);
  }
};
