// Netlify Function to proxy Cerebras API requests
exports.handler = async (event, context) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  // Get the API key from environment variable
  const apiKey = process.env.CEREBRAS_API_KEY;
  
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'API key not configured' })
    };
  }

  try {
    const body = JSON.parse(event.body);
    
    // Make request to Cerebras API
    const response = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: body.model || 'llama3.1-8b',
        messages: body.messages,
        temperature: body.temperature || 0.7,
        max_tokens: body.max_tokens || 20000,
        stream: false
      })
    });

    if (!response.ok) {
      const error = await response.text();
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: `Cerebras API error: ${error}` })
      };
    }

    const data = await response.json();
    
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data)
    };
  } catch (error) {
    console.error('Proxy error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};