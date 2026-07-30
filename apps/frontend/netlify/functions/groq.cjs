// Netlify Function to proxy Groq API requests (including vision analysis)
exports.handler = async (event, context) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  // Get the API key from environment variable
  const apiKey = process.env.GROQ_API_KEY;
  
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Groq API key not configured' })
    };
  }

  try {
    const body = JSON.parse(event.body);
    
    // Make request to Groq API
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: body.model || 'meta-llama/llama-4-maverick-17b-128e-instruct',
        messages: body.messages,
        temperature: body.temperature || 0.3,
        max_tokens: body.max_tokens || 2000
      })
    });

    if (!response.ok) {
      const error = await response.text();
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: `Groq API error: ${error}` })
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
    console.error('Groq proxy error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};