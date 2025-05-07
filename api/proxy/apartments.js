import fetch from 'node-fetch';

export default async function handler(req, res) {
  try {
    const response = await fetch('https://login.smoobu.com/api/apartments', {
      headers: {
        'Api-Key': process.env.SMOOBU_API_TOKEN,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Abruf der Daten', details: error.message });
  }
}

