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
    try {
        const baseUrl = process.env.APP_URL || 'http://localhost:3000';
        const priceRes = await fetch(`${baseUrl}/api/proxy/check-availability`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                arrivalDate: arrivalDate,
                departureDate: departureDate,
                apartments: apartmentId.toString(),
                guests: adults + children,
                customerId: 981908
            })
        });

        if (!priceRes.ok) {
            const errorText = await priceRes.text();
            console.error('Check availability API error:', errorText);
            throw new Error('Failed to fetch pricing from availability API');
        }

        const priceData = await priceRes.json();
        console.log('Price data received:', priceData);

        let totalPrice = 0;

        // Handle the new response structure: { prices: { '2514433': { price: 206, currency: '€' } } }
        if (priceData.prices && typeof priceData.prices === 'object') {
            const apartmentPrice = priceData.prices[apartmentId.toString()];
            if (apartmentPrice && apartmentPrice.price) {
                totalPrice = parseFloat(apartmentPrice.price);
            }
        }
        // Fallback to original price extraction methods
        else if (priceData.price) {
            totalPrice = parseFloat(priceData.price);
        } else if (priceData.totalPrice) {
            totalPrice = parseFloat(priceData.totalPrice);
        } else if (priceData.data && priceData.data.price) {
            totalPrice = parseFloat(priceData.data.price);
        } else if (priceData.apartments && Array.isArray(priceData.apartments)) {
            const apartment = priceData.apartments.find(apt =>
                apt.id == apartmentId || apt.apartmentId == apartmentId
            );
            if (apartment && apartment.price) {
                totalPrice = parseFloat(apartment.price);
            }
        }

        if (totalPrice <= 0) {
            console.error('Invalid price received from API:', priceData);
            throw new Error('Invalid price received from availability API');
        }

        return Math.round(totalPrice * 100);

    } catch (error) {
        console.error('Error fetching Smoobu price:', error);
        throw new Error(`Unable to calculate price: ${error.message}`);
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

        if (!method || !arrivalDate || !departureDate || typeof adults !== 'number' ||
            !apartmentId || !firstName || !lastName || !email || !phone) {
            return res.status(400).json({ error: 'Missing required booking data' })
        }

        const arrival = new Date(arrivalDate)
        const departure = new Date(departureDate)
        const nights = Math.ceil((departure - arrival) / 86400000)

        if (nights <= 0) {
            return res.status(400).json({ error: 'Invalid date range' })
        }

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
                            return_url: `${appUrl}/api/proxy/paypal-success`,
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