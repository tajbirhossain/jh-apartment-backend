export default function handler(req, res) {
  res.status(200).json({
    env_token_set: !!process.env.SMOOBU_API_TOKEN,
    token_snippet: process.env.SMOOBU_API_TOKEN?.substring(0, 8) || 'NOT SET'
  });
}

