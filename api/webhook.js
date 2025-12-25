const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

export const config = {
  api: {
    bodyParser: false,
  },
};

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    req.on('data', (chunk) => { buffer += chunk; });
    req.on('end', () => { resolve(buffer); });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  
  // Health Check
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      environment: {
        hasStripeKey: !!process.env.STRIPE_SECRET_KEY,
        hasWebhookSecret: !!process.env.STRIPE_WEBHOOK_SECRET,
        hasPlayFabTitleId: !!process.env.PLAYFAB_TITLE_ID,
        hasPlayFabSecretKey: !!process.env.PLAYFAB_SECRET_KEY
      }
    });
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  console.log('🔔 Webhook received');
  
  const sig = req.headers['stripe-signature'];
  let event;
  
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
    console.log('✅ Signature verified');
  } catch (err) {
    console.error('❌ Signature failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }
  
  if (event.type === 'checkout.session.completed') {
    
    console.log('💳 Processing payment');
    
    const session = event.data.object;
    const transactionId = session.client_reference_id;
    const stripePaymentId = session.payment_intent;
    const paymentStatus = session.payment_status;
    
    console.log('📝 Transaction ID:', transactionId);
    console.log('✔️  Payment Status:', paymentStatus);
    
    if (!transactionId) {
      console.error('❌ Missing transaction ID');
      return res.status(400).json({ error: 'Missing transaction ID' });
    }
    
    const parts = transactionId.split('_');
    if (parts.length < 3) {
      console.error('❌ Invalid transaction ID format');
      return res.status(400).json({ error: 'Invalid transaction ID' });
    }
    
    const playerId = parts[1];
    console.log('👤 Player ID:', playerId);
    
    try {
      
      console.log('📡 Calling PlayFab...');
      
      // ⭐ สร้าง session object ตาม Cloud Script
      const sessionData = {
        client_reference_id: transactionId,
        payment_intent: stripePaymentId,
        payment_status: paymentStatus
      };
      
      console.log('📦 Session data:', JSON.stringify(sessionData));
      
      const playfabUrl = `https://${process.env.PLAYFAB_TITLE_ID}.playfabapi.com/Server/ExecuteCloudScript`;
      
      const playfabResponse = await fetch(playfabUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SecretKey': process.env.PLAYFAB_SECRET_KEY
        },
        body: JSON.stringify({
          PlayFabId: playerId,
          FunctionName: 'ProcessStripeWebhook',
          FunctionParameter: {
            session: sessionData // ⭐ ส่งแค่ session object
          }
        })
      });
      
      if (!playfabResponse.ok) {
        const errorText = await playfabResponse.text();
        console.error('❌ PlayFab error:', errorText);
        return res.status(500).json({ error: 'PlayFab error' });
      }
      
      const result = await playfabResponse.json();
      console.log('✅ PlayFab response:', result);
      
      if (result.data && result.data.FunctionResult) {
        const functionResult = result.data.FunctionResult;
        
        if (functionResult.success) {
          console.log('✅ Payment processed successfully');
          return res.status(200).json({ 
            received: true, 
            success: true,
            message: 'Payment processed'
          });
        } else {
          console.error('❌ Payment failed:', functionResult.message);
          return res.status(200).json({ 
            received: true, 
            success: false,
            message: functionResult.message
          });
        }
      }
      
      return res.status(200).json({ received: true });
      
    } catch (error) {
      console.error('❌ Error:', error.message);
      return res.status(500).json({ error: 'Internal error' });
    }
    
  }
  
  return res.status(200).json({ received: true });
}
