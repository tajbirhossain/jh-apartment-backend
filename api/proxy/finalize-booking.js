import Stripe from 'stripe';
import fetch from 'node-fetch';

const handleCors = (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Api-Key');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return true;
    }
    return false;
};


let stripe;
try {
    if (process.env.STRIPE_SECRET) {
        stripe = new Stripe(process.env.STRIPE_SECRET);
    } else {
        console.warn('STRIPE_SECRET environment variable is missing');
    }
} catch (error) {
    console.error('Failed to initialize Stripe:', error);
}


const PAYPAL_BASE = process.env.NODE_ENV === 'production'
    ? 'https://api.paypal.com'
    : 'https://api.sandbox.paypal.com';

export default async function handler(req, res) {

    if (handleCors(req, res)) {
        return;
    }


    console.log(`[finalize-booking] Request method: ${req.method}, URL: ${req.url}`);

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { paymentId, method } = req.body;
        console.log('[finalize-booking] Request body:', { paymentId, method });

        if (!paymentId || !method) {
            return res.status(400).json({
                success: false,
                error: 'Missing required parameters: paymentId and method'
            });
        }

        let paymentVerified = false;

        if (method === 'stripe') {
            if (!stripe) {
                return res.status(500).json({
                    success: false,
                    error: 'Stripe is not configured'
                });
            }

            const pi = await stripe.paymentIntents.retrieve(paymentId);
            console.log('[finalize-booking] Stripe payment status:', pi.status);

            if (pi.status !== 'succeeded') {
                return res.status(400).json({
                    success: false,
                    error: 'Zahlung nicht abgeschlossen'
                });
            }


            const bookingPayload = {
                arrivalDate: pi.metadata.arrivalDate,
                departureDate: pi.metadata.departureDate,
                adults: parseInt(pi.metadata.adults, 10),
                children: parseInt(pi.metadata.children || '0', 10),
                
            };

            paymentVerified = true;
        } else if (method === 'paypal') {
            if (!process.env.PP_CLIENT || !process.env.PP_SECRET) {
                return res.status(500).json({
                    success: false,
                    error: 'PayPal is not configured'
                });
            }

            const auth = Buffer.from(`${process.env.PP_CLIENT}:${process.env.PP_SECRET}`)
                .toString('base64');

            const captureRes = await fetch(
                `${PAYPAL_BASE}/v2/checkout/orders/${paymentId}/capture`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Basic ${auth}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            const captureData = await captureRes.json();
            console.log('[finalize-booking] PayPal capture status:', captureData.status);

            if (captureData.status !== 'COMPLETED') {
                return res.status(400).json({
                    success: false,
                    error: 'PayPal-Zahlung fehlgeschlagen'
                });
            }


            const purchaseUnit = captureData.purchase_units?.[0];
            let bookingDetails = {};

            try {
                if (purchaseUnit?.custom_id) {
                    bookingDetails = JSON.parse(purchaseUnit.custom_id);
                }
            } catch (error) {
                console.error('[finalize-booking] Error parsing custom_id:', error);
            }

            const bookingPayload = {
                arrivalDate: bookingDetails.arrivalDate,
                departureDate: bookingDetails.departureDate,
                adults: bookingDetails.adults,
                children: bookingDetails.children || 0,
                
            };

            paymentVerified = true;
        } else {
            return res.status(400).json({
                success: false,
                error: 'Unknown payment method'
            });
        }

        if (paymentVerified) {
            const bookingPayload = {
                apartmentId: process.env.SMOOBU_APARTMENT_ID || '12345',
                channel: 'website',
                status: 'NEW',
                
            };

            if (!process.env.SMOOBU_API_TOKEN) {
                return res.status(500).json({
                    success: false,
                    error: 'Smoobu API is not configured'
                });
            }

            console.log('[finalize-booking] Creating Smoobu reservation with payload:', bookingPayload);

            const smoobuRes = await fetch("https://login.smoobu.com/api/reservations", {
                method: "POST",
                headers: {
                    'Api-Key': process.env.SMOOBU_API_TOKEN,
                    'Authorization': `Bearer ${process.env.SMOOBU_API_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(bookingPayload)
            });

            if (!smoobuRes.ok) {
                const errorText = await smoobuRes.text();
                console.error('[finalize-booking] Smoobu API error:', errorText);
                return res.status(400).json({
                    success: false,
                    error: `Smoobu API error: ${errorText}`
                });
            }

            const data = await smoobuRes.json();
            console.log('[finalize-booking] Smoobu reservation created:', data);

            if (data.id) {
                return res.status(200).json({
                    success: true,
                    reservationId: data.id
                });
            } else {
                throw new Error(data.message || 'Reservierung fehlgeschlagen');
            }
        }
    } catch (error) {
        console.error('[finalize-booking] Error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Server error'
        });
    }
}