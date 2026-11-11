require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/iseerival_api');

async function createFirstUser() {
    const newUser = new User({
        apiKey: 'sk-test-8888-9999', // Твой тестовый ключ
        name: 'Test Partner Co',
        credits: 50,
        plan: 'pro'
    });

    await newUser.save();
    console.log('✅ Тестовый пользователь создан!');
    process.exit();
}

createFirstUser();