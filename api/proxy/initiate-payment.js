import Stripe from 'stripe';
import fetch from 'node-fetch';

// Simple direct CORS handler function
const handleCors = (req, res) => {
    // Set CORS headers explicitly for all responses
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Api-Key');

    // Handle OPTIONS requests immediately
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return true; // Return true to indicate we've handled the request
    }
    return false; // Return false to continue processing
};

// Initialize services with proper error handling
let stripe;
try {
    if (process.env.STRIPE_SECRET) {
        stripe = new Stripe(process.env.STRIPE_SECRET, { apiVersion: '2022-11-15' });
    } else {
        console.warn('STRIPE_SECRET environment variable is missing');
    }
} catch (error) {
    console.error('Failed to initialize Stripe:', error);
}

// PayPal base URL with fallback
const PAYPAL_BASE = process.env.NODE_ENV === 'production'
    ? 'https://api.paypal.com'
    : 'https://api.sandbox.paypal.com';

export default async function handler(req, res) {
    // Always handle CORS first
    if (handleCors(req, res)) {
        return; // Return early for OPTIONS requests
    }

    // Log request to help diagnose issues
    console.log(`[initiate-payment] Request method: ${req.method}, URL: ${req.url}`);

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { method, arrivalDate, departureDate, adults, children } = req.body;
        console.log('[initiate-payment] Request body:', { method, arrivalDate, departureDate, adults, children });

        if (!method || !arrivalDate || !departureDate || typeof adults !== 'number') {
            return res.status(400).json({ error: 'Ungültige Buchungsdaten' });
        }

        const nights = Math.ceil((new Date(departureDate) - new Date(arrivalDate)) / 86400000);
        const nightlyRateCents = 10000;
        const amount = nights * nightlyRateCents;

        if (amount <= 0) {
            return res.status(400).json({ error: 'Ungültiger Gesamtpreis' });
        }

        if (method === 'stripe') {
            if (!stripe) {
                return res.status(500).json({ error: 'Stripe is not configured' });
            }

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

            console.log('[initiate-payment] Stripe payment initiated:', paymentIntent.id);
            return res.status(200).json({
                provider: 'stripe',
                clientSecret: paymentIntent.client_secret,
                paymentId: paymentIntent.id,
            });
        }

        if (method === 'paypal') {
            if (!process.env.PP_CLIENT || !process.env.PP_SECRET) {
                return res.status(500).json({ error: 'PayPal is not configured' });
            }

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
                        return_url: `${process.env.APP_URL || 'http://localhost:3000'}/api/paypal-success`,
                        cancel_url: `${process.env.APP_URL || 'http://localhost:3000'}/booking-cancel`,
                    },
                }),
            });

            if (!orderRes.ok) {
                const errorData = await orderRes.json().catch(() => ({}));
                throw new Error(errorData.message || 'PayPal: Order creation failed');
            }

            const orderData = await orderRes.json();
            const approveLink = orderData.links.find(l => l.rel === 'approve');

            console.log('[initiate-payment] PayPal payment initiated:', orderData.id);
            return res.status(200).json({
                provider: 'paypal',
                paymentId: orderData.id,
                approvalUrl: approveLink.href,
            });
        }

        return res.status(400).json({ error: 'Unknown payment method' });
    } catch (err) {
        console.error('[initiate-payment] Error:', err);
        return res.status(500).json({ error: err.message || 'Server error' });
    }
}