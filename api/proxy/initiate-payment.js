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

// Initialize Stripe if environment variable is available
let stripe
if (process.env.STRIPE_SECRET) {
    stripe = new Stripe(process.env.STRIPE_SECRET, { apiVersion: '2022-11-15' })
}

// PayPal API base URL based on environment
const PAYPAL_BASE =
    process.env.NODE_ENV === 'production'
        ? 'https://api.paypal.com'
        : 'https://api.sandbox.paypal.com'

export default async function handler(req, res) {
    // Handle CORS preflight
    if (handleCors(req, res)) return
    
    // Only allow POST method
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' })

    try {
        // Extract required data from request body
        const { 
            method, arrivalDate, departureDate, adults, children = 0,
            apartmentId, firstName, lastName, email, phone
        } = req.body

        // Validate required fields
        if (!method || !arrivalDate || !departureDate || typeof adults !== 'number') {
            return res.status(400).json({ error: 'Ungültige Buchungsdaten' })
        }

        // Calculate booking amount
        const nights = Math.ceil((new Date(departureDate) - new Date(arrivalDate)) / 86400000)
        const amount = nights * 10000 // 100 EUR per night in cents
        if (amount <= 0) {
            return res.status(400).json({ error: 'Ungültiger Gesamtpreis' })
        }

        // Store full booking data for later use
        const bookingData = {
            arrivalDate,
            departureDate,
            adults: adults.toString(),
            children: children.toString(),
            apartmentId,
            firstName,
            lastName,
            email,
            phone
        }

        // Handle Stripe payment
        if (method === 'stripe') {
            if (!stripe) {
                return res.status(500).json({ error: 'Stripe is not configured' })
            }

            const paymentIntent = await stripe.paymentIntents.create({
                amount,
                currency: 'eur',
                metadata: bookingData,
            })

            return res.status(200).json({
                provider: 'stripe',
                clientSecret: paymentIntent.client_secret,
                paymentId: paymentIntent.id,
            })
        }

        // Handle PayPal payment
        if (method === 'paypal') {
            // Check if PayPal credentials are configured
            if (!process.env.PP_CLIENT || !process.env.PP_SECRET) {
                console.error('PayPal credentials missing');
                return res.status(500).json({ error: 'PayPal is not configured' })
            }

            // Create Basic Auth header for PayPal API
            const auth = Buffer.from(`${process.env.PP_CLIENT}:${process.env.PP_SECRET}`).toString('base64')
            
            // Set correct application URLs
            const appUrl = process.env.APP_URL || 'http://localhost:3000';
            
            // Create PayPal order
            try {
                const orderRes = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Basic ${auth}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        intent: 'CAPTURE',
                        purchase_units: [
                            {
                                amount: {
                                    currency_code: 'EUR',
                                    value: (amount / 100).toFixed(2),
                                },
                                custom_id: JSON.stringify(bookingData),
                            },
                        ],
                        application_context: {
                            return_url: `${appUrl}/api/paypal-success`,
                            cancel_url: `${appUrl}/booking-cancel`,
                        },
                    }),
                })

                // Check for API errors
                if (!orderRes.ok) {
                    const errorText = await orderRes.text();
                    console.error('PayPal API error:', errorText);
                    
                    let errorData = {};
                    try {
                        errorData = JSON.parse(errorText);
                    } catch (e) {
                        // Ignore parsing error
                    }
                    
                    const msg = errorData.message || 'PayPal: Order creation failed';
                    return res.status(500).json({ error: msg })
                }

                const orderData = await orderRes.json()
                const approveLink = orderData.links.find(l => l.rel === 'approve')
                if (!approveLink) {
                    return res.status(500).json({ error: 'Missing approval link from PayPal' })
                }

                return res.status(200).json({
                    provider: 'paypal',
                    paymentId: orderData.id,
                    approvalUrl: approveLink.href,
                })
            } catch (paypalError) {
                console.error('PayPal request error:', paypalError);
                return res.status(500).json({ error: paypalError.message || 'PayPal request failed' })
            }
        }

        return res.status(400).json({ error: 'Unknown payment method' })
    } catch (err) {
        console.error('Payment initiation error:', err);
        return res.status(500).json({ error: err.message || 'Server error' })
    }
}