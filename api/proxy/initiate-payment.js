import Stripe from 'stripe';
import fetch from 'node-fetch';

const stripe = new Stripe(process.env.STRIPE_SECRET, { apiVersion: '2022-11-15' });
const PAYPAL_BASE = process.env.NODE_ENV === 'production'
    ? 'https://api.paypal.com'
    : 'https://api.sandbox.paypal.com';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { method, arrivalDate, departureDate, adults, children /*…etc*/ } = req.body;


    if (!method || !arrivalDate || !departureDate || typeof adults !== 'number') {
        return res.status(400).json({ error: 'Ungültige Buchungsdaten' });
    }


    const nights = Math.ceil((new Date(departureDate) - new Date(arrivalDate)) / 86400000);
    const nightlyRateCents = 10000;
    const amount = nights * nightlyRateCents;
    if (amount <= 0) {
        return res.status(400).json({ error: 'Ungültiger Gesamtpreis' });
    }

    try {
        if (method === 'stripe') {

            const paymentIntent = await stripe.paymentIntents.create({
                amount,
                currency: 'eur',
                metadata: {
                    arrivalDate,
                    departureDate,
                    adults: adults.toString(),
                    children: (children || 0).toString(),

                },
            });
            return res.status(200).json({
                provider: 'stripe',
                clientSecret: paymentIntent.client_secret,
                paymentId: paymentIntent.id,
            });
        }

        if (method === 'paypal') {

            const auth = Buffer.from(`${process.env.PP_CLIENT}:${process.env.PP_SECRET}`).toString('base64');
            const orderRes = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
                method: 'POST',
                headers: {
                    Authorization: `Basic ${auth}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    intent: 'CAPTURE',
                    purchase_units: [{
                        amount: {
                            currency_code: 'EUR',
                            value: (amount / 100).toFixed(2),
                        },
                        custom_id: JSON.stringify({
                            arrivalDate,
                            departureDate,
                            adults,
                            children: children || 0,
                        }),
                    }],
                    application_context: {
                        return_url: `${process.env.APP_URL}/api/paypal-success`,
                        cancel_url: `${process.env.APP_URL}/booking-cancel`,
                    },
                }),
            });

            const orderData = await orderRes.json();
            if (!orderRes.ok) {
                throw new Error(orderData.message || 'PayPal: Order creation failed');
            }

            const approveLink = orderData.links.find(l => l.rel === 'approve');
            return res.status(200).json({
                provider: 'paypal',
                paymentId: orderData.id,
                approvalUrl: approveLink.href,
            });
        }

        return res.status(400).json({ error: 'Unknown payment method' });
    } catch (err) {
        console.error('initiate-payment error:', err);
        return res.status(500).json({ error: err.message || 'Server error' });
    }
}
