import Stripe from 'stripe'
import fetch from 'node-fetch'

const handleCors = (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Api-Key')
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

async function getSmoobuPrice(apartmentId, arrivalDate, departureDate, adults, children) {
    const baseUrl = process.env.APP_URL || 'http://localhost:3000'
    const res = await fetch(`${baseUrl}/api/proxy/check-availability`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            arrivalDate,
            departureDate,
            apartments: apartmentId.toString(),
            guests: adults + children,
            customerId: 981908
        })
    })
    if (!res.ok) {
        const text = await res.text()
        throw new Error(text || 'Failed to fetch pricing')
    }
    const data = await res.json()
    let price = 0
    if (data.prices && data.prices[apartmentId]) {
        price = parseFloat(data.prices[apartmentId].price)
    } else if (data.price) {
        price = parseFloat(data.price)
    } else if (data.totalPrice) {
        price = parseFloat(data.totalPrice)
    } else if (data.data && data.data.price) {
        price = parseFloat(data.data.price)
    } else if (Array.isArray(data.apartments)) {
        const apt = data.apartments.find(a => a.id == apartmentId || a.apartmentId == apartmentId)
        if (apt) price = parseFloat(apt.price)
    }
    if (price <= 0) throw new Error('Invalid price')
    return Math.round(price * 100)
}

export default async function handler(req, res) {
    if (handleCors(req, res)) return
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' })

    const {
        method,
        arrivalDate,
        departureDate,
        adults,
        children = 0,
        apartmentId,
        firstName,
        lastName,
        email,
        phone,
        channelId
    } = req.body

    if (!method || !arrivalDate || !departureDate || typeof adults !== 'number' ||
        !apartmentId || !firstName || !lastName || !email || !phone) {
        return res.status(400).json({ error: 'Missing required booking data' })
    }

    const nights = Math.ceil((new Date(departureDate) - new Date(arrivalDate)) / 86400000)
    if (nights <= 0) {
        return res.status(400).json({ error: 'Invalid date range' })
    }

    let amount
    try {
        amount = await getSmoobuPrice(apartmentId, arrivalDate, departureDate, adults, children)
    } catch (e) {
        return res.status(500).json({ error: 'Unable to calculate price' })
    }

    if (amount <= 0) {
        return res.status(400).json({ error: 'Invalid total price' })
    }

    const bookingData = {
        arrivalDate,
        departureDate,
        adults: adults.toString(),
        children: children.toString(),
        apartmentId: apartmentId.toString(),
        firstName,
        lastName,
        email,
        phone,
        channelId: channelId ? channelId.toString() : '70',
        totalAmount: amount.toString(),
        nights: nights.toString()
    }

    if (method === 'stripe') {
        if (!stripe) return res.status(500).json({ error: 'Stripe not configured' })
        const pi = await stripe.paymentIntents.create({
            amount,
            currency: 'eur',
            metadata: bookingData,
            description: `Booking - Apartment ${apartmentId}`
        })
        return res.status(200).json({
            provider: 'stripe',
            clientSecret: pi.client_secret,
            paymentId: pi.id,
            amount,
            bookingData
        })
    }

    if (method === 'paypal') {
        if (!process.env.PP_CLIENT || !process.env.PP_SECRET) {
            return res.status(500).json({ error: 'PayPal not configured' })
        }
        const auth = Buffer.from(`${process.env.PP_CLIENT}:${process.env.PP_SECRET}`).toString('base64')
        const appUrl = process.env.APP_URL || 'http://localhost:3000'
        const orderRes = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${auth}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                intent: 'CAPTURE',
                purchase_units: [{
                    amount: { currency_code: 'EUR', value: (amount / 100).toFixed(2) },
                    description: `Booking - Apartment ${apartmentId}`
                }],
                application_context: {
                    return_url: `${appUrl}/booking/paypal-callback`,
                    cancel_url: `${appUrl}/booking-cancel`
                }
            })
        })
        if (!orderRes.ok) {
            const text = await orderRes.text()
            let msg = 'PayPal order creation failed'
            try { msg = JSON.parse(text).message } catch { }
            return res.status(500).json({ error: msg })
        }
        const order = await orderRes.json()
        const approveLink = order.links.find(l => l.rel === 'approve')
        return res.status(200).json({
            provider: 'paypal',
            paymentId: order.id,
            approvalUrl: approveLink.href,
            amount,
            bookingData
        })
    }

    return res.status(400).json({ error: 'Unknown payment method' })
}
