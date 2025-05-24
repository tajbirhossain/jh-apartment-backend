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

async function getSmoobuPrice(apartmentId, arrival, departure, adults, children) {
    const baseUrl = process.env.APP_URL || 'http://localhost:3000'
    const res = await fetch(`${baseUrl}/api/proxy/check-availability`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ arrivalDate: arrival, departureDate: departure, apartments: apartmentId, guests: adults + children, customerId: 981908 })
    })
    if (!res.ok) throw new Error('Pricing failed')
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

async function createSmoobuBooking(b) {
    const payload = {
        apartmentId: parseInt(b.apartmentId),
        arrivalDate: b.arrivalDate,
        departureDate: b.departureDate,
        adults: parseInt(b.adults),
        children: parseInt(b.children || '0'),
        channelId: parseInt(b.channelId || '70'),
        firstName: b.firstName,
        lastName: b.lastName,
        email: b.email,
        phone: b.phone,
        notice: `Online booking - Payment confirmed`,
        price: parseFloat(b.totalAmount) / 100
    }


    console.log('Smoobu booking payload:', JSON.stringify(payload, null, 2))

    const res = await fetch('https://login.smoobu.com/api/reservations', {
        method: 'POST',
        headers: {
            'Api-Key': process.env.SMOOBU_API_TOKEN,
            'Authorization': `Bearer ${process.env.SMOOBU_API_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    })

    const txt = await res.text()
    console.log('Smoobu response:', txt)

    if (!res.ok) throw new Error(txt || 'Smoobu error')

    const data = JSON.parse(txt)
    if (!data.id) throw new Error(data.message || 'Reservation failed')
    return data
}


export default async function handler(req, res) {
    if (handleCors(req, res)) return
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' })

    const { paymentId, method, bookingData } = req.body
    if (!paymentId || !method || !bookingData) {
        return res.status(400).json({ success: false, error: 'Missing paymentId, method or bookingData' })
    }

    if (method === 'stripe') {
        if (!stripe) return res.status(500).json({ success: false, error: 'Stripe not configured' })
        const pi = await stripe.paymentIntents.retrieve(paymentId)
        if (pi.status !== 'succeeded') {
            return res.status(400).json({ success: false, error: 'Payment not completed' })
        }
    } else if (method === 'paypal') {
        if (!process.env.PP_CLIENT || !process.env.PP_SECRET) {
            return res.status(500).json({ success: false, error: 'PayPal not configured' })
        }
        const auth = Buffer.from(`${process.env.PP_CLIENT}:${process.env.PP_SECRET}`).toString('base64')
        const capRes = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${paymentId}/capture`, {
            method: 'POST',
            headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }
        })
        const cap = await capRes.json()
        if (cap.status !== 'COMPLETED') {
            return res.status(400).json({ success: false, error: 'PayPal capture failed' })
        }
    } else {
        return res.status(400).json({ success: false, error: 'Unknown payment method' })
    }

    const { apartmentId, arrivalDate, departureDate, adults, children = '0', totalAmount } = bookingData
    let serverPrice
    try {
        serverPrice = await getSmoobuPrice(
            bookingData.apartmentId,
            bookingData.arrivalDate,
            bookingData.departureDate,
            parseInt(adults, 10),
            parseInt(children, 10)
        )
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Price recalculation failed' })
    }

    if (serverPrice !== parseInt(totalAmount, 10)) {
        return res.status(400).json({ success: false, error: 'Payment amount mismatch' })
    }

    try {
        const reservation = await createSmoobuBooking(bookingData)
        return res.status(200).json({
            success: true,
            reservationId: reservation.id,
            message: 'Booking confirmed successfully'
        })
    } catch (e) {
        return res.status(500).json({
            success: false,
            error: 'Booking creation failed. Please contact support.',
            bookingError: e.message
        })
    }
}
