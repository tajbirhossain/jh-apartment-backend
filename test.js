const fetch = require('node-fetch');
fetch('https://api.github.com')
  .then(res => res.json())
  .then(data => console.log(data))
  .catch(err => console.error(err));
