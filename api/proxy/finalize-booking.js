import Stripe from 'stripe'
import fetch from 'node-fetch'

const handleCors = (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Api-Key')
    if (req.method === 'OPTIONS') {
        res.status(200).end()
        return true
    }
    return false
}

let stripe
if (process.env.STRIPE_SECRET) {
    stripe = new Stripe(process.env.STRIPE_SECRET, { apiVersion: '2022-11-15' })
}

const PAYPAL_BASE =
    process.env.NODE_ENV === 'production'
        ? 'https://api.paypal.com'
        : 'https://api.sandbox.paypal.com'

export default async function handler(req, res) {
    if (handleCors(req, res)) return
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' })

    const { paymentId, method } = req.body
    if (!paymentId || !method) {
        return res.status(400).json({ error: 'Missing paymentId or method' })
    }

    try {
        let bookingDetails

        if (method === 'stripe') {
            if (!stripe) {
                return res.status(500).json({ error: 'Stripe is not configured' })
            }
            const pi = await stripe.paymentIntents.retrieve(paymentId)
            if (pi.status !== 'succeeded') {
                return res.status(400).json({ error: 'Zahlung nicht abgeschlossen' })
            }
            bookingDetails = {
                arrivalDate: pi.metadata.arrivalDate,
                departureDate: pi.metadata.departureDate,
                apartmentId: pi.metadata.apartmentId,
                channelId: pi.metadata.channelId,
                adults: Number(pi.metadata.adults),
                children: Number(pi.metadata.children || 0),
                firstName: pi.metadata.firstName,
                lastName: pi.metadata.lastName,
                email: pi.metadata.email,
                phone: pi.metadata.phone
            }
        } else if (method === 'paypal') {
            if (!process.env.PP_CLIENT || !process.env.PP_SECRET) {
                return res.status(500).json({ error: 'PayPal is not configured' })
            }
            const auth = Buffer.from(`${process.env.PP_CLIENT}:${process.env.PP_SECRET}`).toString('base64')
            const captureRes = await fetch(
                `${PAYPAL_BASE}/v2/checkout/orders/${paymentId}/capture`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Basic ${auth}`,
                        'Content-Type': 'application/json'
                    }
                }
            )
            const captureData = await captureRes.json()
            if (captureData.status !== 'COMPLETED') {
                return res.status(400).json({ error: 'PayPal-Zahlung fehlgeschlagen' })
            }
            const pu = captureData.purchase_units?.[0] || {}
            let custom = {}
            try { if (pu.custom_id) custom = JSON.parse(pu.custom_id) } catch { }
            bookingDetails = {
                arrivalDate: custom.arrivalDate,
                departureDate: custom.departureDate,
                apartmentId: custom.apartmentId,
                channelId: custom.channelId,
                adults: custom.adults,
                children: custom.children || 0,
                firstName: custom.firstName,
                lastName: custom.lastName,
                email: custom.email,
                phone: custom.phone
            }
        } else {
            return res.status(400).json({ error: 'Unknown payment method' })
        }

        if (!process.env.SMOOBU_API_TOKEN) {
            return res.status(500).json({ error: 'Smoobu API is not configured' })
        }

        const smoobuPayload = {
            apartmentId: bookingDetails.apartmentId,
            channel: 'website',
            status: 'NEW',
            checkin: bookingDetails.arrivalDate,
            checkout: bookingDetails.departureDate,
            guests: {
                adults: bookingDetails.adults,
                children: bookingDetails.children
            },
            customer: {
                firstName: bookingDetails.firstName,
                lastName: bookingDetails.lastName,
                email: bookingDetails.email,
                phone: bookingDetails.phone
            }
        }

        const smoobuRes = await fetch("https://login.smoobu.com/api/reservations", {
            method: 'POST',
            headers: {
                'Api-Key': process.env.SMOOBU_API_TOKEN,
                'Authorization': `Bearer ${process.env.SMOOBU_API_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(smoobuPayload)
        })

        if (!smoobuRes.ok) {
            const errorText = await smoobuRes.text()
            return res.status(500).json({ error: `Smoobu API error: ${errorText}` })
        }

        const data = await smoobuRes.json()
        return res.status(200).json({ success: true, reservationId: data.id })

    } catch (err) {
        return res.status(500).json({ success: false, error: err.message || 'Server error' })
    }
}
