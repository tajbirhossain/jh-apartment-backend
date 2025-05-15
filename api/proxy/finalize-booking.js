import Stripe from 'stripe';
import fetch from 'node-fetch';
const stripe = new Stripe(process.env.STRIPE_SECRET);

export default async function handler(req, res) {
    const { paymentId, method } = req.body;

    if (method === 'stripe') {
        const pi = await stripe.paymentIntents.retrieve(paymentId);
        if (pi.status !== 'succeeded') {
            return res.json({ success: false, error: 'Zahlung nicht abgeschlossen' });
        }
    } else {
        const auth = Buffer.from(`${process.env.PP_CLIENT}:${process.env.PP_SECRET}`)
            .toString('base64');
        const captureRes = await fetch(
            `https://api.paypal.com/v2/checkout/orders/${paymentId}/capture`,
            {
                method: 'POST', headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        const captureData = await captureRes.json();
        if (captureData.status !== 'COMPLETED') {
            return res.json({ success: false, error: 'PayPal-Zahlung fehlgeschlagen' });
        }
    }

    try {
        const bookingPayload = {/* reconstruct from metadata or session */ };
        const smoobuRes = await fetch("https://login.smoobu.com/api/reservations", {
            method: "POST",
            headers: {
                'Api-Key': process.env.SMOOBU_API_TOKEN,
                'Authorization': `Bearer ${process.env.SMOOBU_API_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(bookingPayload)
        });
        const data = await smoobuRes.json();
        if (data.id) {
            return res.json({ success: true, reservationId: data.id });
        } else {
            throw new Error(data.message || 'Reservierung fehlgeschlagen');
        }
    } catch (error) {
        return res.json({ success: false, error: error.message });
    }
}
