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

// Function to get price from Smoobu
async function getSmoobuPrice(apartmentId, arrivalDate, departureDate, adults, children) {
    if (!process.env.SMOOBU_API_TOKEN) {
        throw new Error('Smoobu API is not configured')
    }

    try {
        // Get apartment details and pricing
        const priceRes = await fetch(
            `https://login.smoobu.com/api/apartments/${apartmentId}/calendar?start_date=${arrivalDate}&end_date=${departureDate}`,
            {
                headers: {
                    'Api-Key': process.env.SMOOBU_API_TOKEN,
                    'Authorization': `Bearer ${process.env.SMOOBU_API_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        )

        if (!priceRes.ok) {
            throw new Error('Failed to fetch pricing from Smoobu')
        }

        const priceData = await priceRes.json()

        // Calculate total price based on Smoobu's pricing
        // This is a simplified calculation - you might need to adjust based on Smoobu's response structure
        let totalPrice = 0

        if (priceData.data && Array.isArray(priceData.data)) {
            for (const day of priceData.data) {
                if (day.price) {
                    totalPrice += parseFloat(day.price)
                }
            }
        }

        // Add any additional fees based on guest count
        // You might want to get this from Smoobu's apartment settings
        const guestFee = Math.max(0, (adults + children - 2)) * 10 // Example: 10 EUR per extra guest
        totalPrice += guestFee

        return Math.round(totalPrice * 100) // Convert to cents

    } catch (error) {
        console.error('Error fetching Smoobu price:', error)
        throw new Error('Unable to calculate price from Smoobu')
    }
}

export default async function handler(req, res) {
    if (handleCors(req, res)) return

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' })

    try {
        const {
            method, arrivalDate, departureDate, adults, children = 0,
            apartmentId, firstName, lastName, email, phone, channelId
        } = req.body

        // Validate required fields
        if (!method || !arrivalDate || !departureDate || typeof adults !== 'number' ||
            !apartmentId || !firstName || !lastName || !email || !phone) {
            return res.status(400).json({ error: 'Missing required booking data' })
        }

        // Validate dates
        const arrival = new Date(arrivalDate)
        const departure = new Date(departureDate)
        const nights = Math.ceil((departure - arrival) / 86400000)

        if (nights <= 0) {
            return res.status(400).json({ error: 'Invalid date range' })
        }

        // Get actual price from Smoobu
        let amount
        try {
            amount = await getSmoobuPrice(apartmentId, arrivalDate, departureDate, adults, children)
        } catch (error) {
            console.error('Pricing error:', error)
            return res.status(500).json({ error: 'Unable to calculate price' })
        }

        if (amount <= 0) {
            return res.status(400).json({ error: 'Invalid total price' })
        }

        // Store all booking data for later use
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
            channelId: channelId ? channelId.toString() : '70', // Default to 70 if not provided
            totalAmount: amount.toString(), // Store the calculated amount
            nights: nights.toString()
        }

        if (method === 'stripe') {
            if (!stripe) {
                return res.status(500).json({ error: 'Stripe is not configured' })
            }

            const paymentIntent = await stripe.paymentIntents.create({
                amount,
                currency: 'eur',
                metadata: bookingData,
                description: `Booking for ${nights} nights - Apartment ${apartmentId}`,
            })

            return res.status(200).json({
                provider: 'stripe',
                clientSecret: paymentIntent.client_secret,
                paymentId: paymentIntent.id,
                amount: amount,
                nights: nights
            })
        }

        if (method === 'paypal') {
            if (!process.env.PP_CLIENT || !process.env.PP_SECRET) {
                console.error('PayPal credentials missing');
                return res.status(500).json({ error: 'PayPal is not configured' })
            }

            const auth = Buffer.from(`${process.env.PP_CLIENT}:${process.env.PP_SECRET}`).toString('base64')

            const appUrl = process.env.APP_URL || 'http://localhost:3000';

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
                                description: `Booking for ${nights} nights - Apartment ${apartmentId}`,
                                custom_id: JSON.stringify(bookingData),
                            },
                        ],
                        application_context: {
                            return_url: `${appUrl}/api/paypal-success`,
                            cancel_url: `${appUrl}/booking-cancel`,
                        },
                    }),
                })

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
                    amount: amount,
                    nights: nights
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