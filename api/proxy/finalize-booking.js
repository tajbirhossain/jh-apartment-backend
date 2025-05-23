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

// Function to create booking in Smoobu
async function createSmoobuBooking(bookingData) {
    if (!process.env.SMOOBU_API_TOKEN) {
        throw new Error('Smoobu API is not configured');
    }

    // Prepare the booking payload for Smoobu
    const smoobuPayload = {
        apartment: {
            id: parseInt(bookingData.apartmentId)
        },
        arrival: bookingData.arrivalDate,
        departure: bookingData.departureDate,
        adults: parseInt(bookingData.adults),
        children: parseInt(bookingData.children || '0'),
        channel: {
            id: parseInt(bookingData.channelId || '70')
        },
        guest: {
            firstName: bookingData.firstName,
            lastName: bookingData.lastName,
            email: bookingData.email,
            phone: bookingData.phone
        },
        // Add any additional fields your Smoobu setup requires
        notice: `Online booking - Payment confirmed`,
        price: parseFloat(bookingData.totalAmount) / 100, // Convert from cents to euros
    };

    console.log('[finalize-booking] Creating Smoobu reservation with payload:', smoobuPayload);

    const smoobuRes = await fetch("https://login.smoobu.com/api/reservations", {
        method: "POST",
        headers: {
            'Api-Key': process.env.SMOOBU_API_TOKEN,
            'Authorization': `Bearer ${process.env.SMOOBU_API_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(smoobuPayload)
    });

    if (!smoobuRes.ok) {
        const errorText = await smoobuRes.text();
        console.error('[finalize-booking] Smoobu API error:', errorText);
        throw new Error(`Smoobu API error: ${errorText}`);
    }

    const data = await smoobuRes.json();
    console.log('[finalize-booking] Smoobu reservation created:', data);

    if (!data.id) {
        throw new Error(data.message || 'Reservation creation failed');
    }

    return data;
}

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

        let bookingData = null;
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
                    error: 'Payment not completed'
                });
            }

            // Extract booking data from Stripe metadata
            bookingData = {
                arrivalDate: pi.metadata.arrivalDate,
                departureDate: pi.metadata.departureDate,
                adults: pi.metadata.adults,
                children: pi.metadata.children || '0',
                apartmentId: pi.metadata.apartmentId,
                firstName: pi.metadata.firstName,
                lastName: pi.metadata.lastName,
                email: pi.metadata.email,
                phone: pi.metadata.phone,
                channelId: pi.metadata.channelId || '70',
                totalAmount: pi.metadata.totalAmount,
                nights: pi.metadata.nights
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

            // Capture the PayPal payment
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
                    error: 'PayPal payment failed'
                });
            }

            // Extract booking data from PayPal custom_id
            const purchaseUnit = captureData.purchase_units?.[0];
            if (purchaseUnit?.custom_id) {
                try {
                    bookingData = JSON.parse(purchaseUnit.custom_id);
                } catch (error) {
                    console.error('[finalize-booking] Error parsing PayPal custom_id:', error);
                    return res.status(500).json({
                        success: false,
                        error: 'Failed to parse booking data from PayPal'
                    });
                }
            } else {
                return res.status(500).json({
                    success: false,
                    error: 'Missing booking data in PayPal response'
                });
            }

            paymentVerified = true;

        } else {
            return res.status(400).json({
                success: false,
                error: 'Unknown payment method'
            });
        }

        // If payment is verified, create the booking in Smoobu
        if (paymentVerified && bookingData) {
            try {
                const reservation = await createSmoobuBooking(bookingData);

                console.log('[finalize-booking] Booking successfully created with ID:', reservation.id);

                return res.status(200).json({
                    success: true,
                    reservationId: reservation.id,
                    message: 'Booking confirmed successfully'
                });

            } catch (bookingError) {
                console.error('[finalize-booking] Booking creation error:', bookingError);

                // At this point, payment was successful but booking failed
                // You might want to implement a retry mechanism or manual intervention
                return res.status(500).json({
                    success: false,
                    error: 'Payment successful but booking creation failed. Please contact support.',
                    paymentId: paymentId,
                    bookingError: bookingError.message
                });
            }
        } else {
            return res.status(500).json({
                success: false,
                error: 'Payment verification failed'
            });
        }

    } catch (error) {
        console.error('[finalize-booking] Error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Server error'
        });
    }
}