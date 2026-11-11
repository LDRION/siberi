const axios = require('axios');

async function test() {
    try {
        const response = await axios.post('http://localhost:3000/api/v1/analyze', {
            prompt: "Расскажи в двух предложениях, что такое API."
        }, {
            headers: { 'Authorization': 'Bearer sk-test-8888-9999' }
        });

        console.log('✅ Задача создана:', response.data);
        
        const taskId = response.data.taskId;
        console.log('⏳ Ожидаем результат...');

        // Проверяем статус каждые 5 секунд
        const interval = setInterval(async () => {
            const res = await axios.get(`http://localhost:3000/api/v1/result/${taskId}`);
            console.log('📊 Статус:', res.data.status);
            
            if (res.data.status === 'completed') {
                console.log('🏆 Ответ от Gemini:', res.data.result);
                clearInterval(interval);
            } else if (res.data.status === 'error') {
                console.log('❌ Ошибка:', res.data.error);
                clearInterval(interval);
            }
        }, 5000);

    } catch (error) {
        console.error('❌ Ошибка теста:', error.response ? error.response.data : error.message);
    }
}

test();