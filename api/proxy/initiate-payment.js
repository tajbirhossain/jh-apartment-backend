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

const PAYPAL_BASE = process.env.NODE_ENV === 'production'
  ? 'https://api.paypal.com'
  : 'https://api.sandbox.paypal.com'

export default async function handler(req, res) {
  try {
    if (handleCors(req, res)) return
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' })

    console.log('[initiate-payment] incoming body:', req.body)
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
      channelId = 'website'
    } = req.body

    if (!method || !arrivalDate || !departureDate || typeof adults !== 'number') {
      return res.status(400).json({ error: 'Ungültige Buchungsdaten' })
    }

    if (!process.env.SMOOBU_API_TOKEN) {
      return res.status(500).json({ error: 'Smoobu API is not configured' })
    }

    // --- Fetch daily rates and sum them ---
    const ratesRes = await fetch(
      `https://login.smoobu.com/api/rates?apartments[]=${apartmentId}` +
      `&start_date=${arrivalDate}&end_date=${departureDate}`,
      {
        headers: {
          'Api-Key':       process.env.SMOOBU_API_TOKEN,
          'Authorization': `Bearer ${process.env.SMOOBU_API_TOKEN}`
        }
      }
    )
    if (!ratesRes.ok) {
      const err = await ratesRes.text()
      return res.status(500).json({ error: `Smoobu rates error: ${err}` })
    }

    const ratesData = await ratesRes.json()
    const days = ratesData[apartmentId] || []
    const totalPrice = days.reduce((sum, d) => sum + Number(d.price || 0), 0)
    const amount = Math.round(totalPrice * 100)
    if (amount <= 0) {
      return res.status(400).json({ error: 'Ungültiger Gesamtpreis' })
    }

    const bookingData = {
      arrivalDate,
      departureDate,
      apartmentId: apartmentId.toString(),
      channelId:   channelId.toString(),
      adults:      adults.toString(),
      children:    children.toString(),
      firstName,
      lastName,
      email,
      phone
    }

    if (method === 'stripe') {
      if (!stripe) return res.status(500).json({ error: 'Stripe is not configured' })
      const pi = await stripe.paymentIntents.create({ amount, currency: 'eur', metadata: bookingData })
      return res.status(200).json({
        provider:     'stripe',
        clientSecret: pi.client_secret,
        paymentId:    pi.id
      })
    }

    if (method === 'paypal') {
      if (!process.env.PP_CLIENT || !process.env.PP_SECRET) {
        return res.status(500).json({ error: 'PayPal is not configured' })
      }
      const auth   = Buffer.from(`${process.env.PP_CLIENT}:${process.env.PP_SECRET}`).toString('base64')
      const appUrl = process.env.APP_URL || 'http://localhost:3000'

      const orderBody = {
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: 'EUR',
            value:         (amount / 100).toFixed(2)
          },
          custom_id: JSON.stringify(bookingData)
        }],
        application_context: {
          return_url: `${appUrl}/api/paypal-success`,
          cancel_url: `${appUrl}/booking-cancel`
        }
      }

      console.log('[initiate-payment] PayPal request body:', JSON.stringify(orderBody))

      const orderRes = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
        method:  'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(orderBody)
      })

      const orderText = await orderRes.text()
      if (!orderRes.ok) {
        console.error('[initiate-payment] PayPal error status:', orderRes.status)
        console.error('[initiate-payment] PayPal response:', orderText)
        let msg = 'PayPal: Order creation failed'
        try { msg = JSON.parse(orderText).message } catch {}
        return res.status(400).json({ error: msg })
      }

      const orderData   = JSON.parse(orderText)
      const approveLink = orderData.links.find(l => l.rel === 'approve')
      if (!approveLink) {
        console.error('[initiate-payment] Missing approval link in', orderData)
        return res.status(500).json({ error: 'Missing approval link from PayPal' })
      }

      return res.status(200).json({
        provider:    'paypal',
        paymentId:   orderData.id,
        approvalUrl: approveLink.href
      })
    }

    return res.status(400).json({ error: 'Unknown payment method' })

  } catch (err) {
    console.error('[initiate-payment] Uncaught error:', err)
    return res.status(500).json({ error: err.message || 'Unknown server error' })
  }
}
