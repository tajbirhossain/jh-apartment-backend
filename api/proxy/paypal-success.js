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

export default async function handler(req, res) {
    if (handleCors(req, res)) {
        return;
    }

    console.log('[paypal-success] Request received:', req.query);

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { token: paymentId, PayerID } = req.query;

    if (!paymentId) {
        return res.status(400).json({ error: 'Missing payment ID' });
    }

    try {
        // Call the finalize-booking endpoint to complete the booking
        const baseUrl = process.env.APP_URL || 'http://localhost:3000';
        const finalizeRes = await fetch(`${baseUrl}/api/proxy/finalize-booking`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                paymentId: paymentId,
                method: 'paypal'
            })
        });

        const finalizeData = await finalizeRes.json();

        if (finalizeData.success) {
            // Redirect to success page with reservation ID
            const successUrl = `${baseUrl}/booking-success?reservationId=${finalizeData.reservationId}`;
            return res.redirect(302, successUrl);
        } else {
            // Redirect to error page with error message
            const errorUrl = `${baseUrl}/booking-error?error=${encodeURIComponent(finalizeData.error)}`;
            return res.redirect(302, errorUrl);
        }

    } catch (error) {
        console.error('[paypal-success] Error:', error);
        const errorUrl = `${process.env.APP_URL || 'http://localhost:3000'}/booking-error?error=${encodeURIComponent('Booking processing failed')}`;
        return res.redirect(302, errorUrl);
    }
}