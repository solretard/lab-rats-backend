require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/twitch', require('./routes/twitch'));
app.use('/api/whiskers', require('./routes/whiskers'));
app.use('/api/doc', require('./routes/doc'));
app.use('/api/squint', require('./routes/squint'));
app.use('/api/dredd', require('./routes/dredd'));

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Lab Rats backend running on port ${PORT}`));
