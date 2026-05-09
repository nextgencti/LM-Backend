const axios = require('axios');

async function testPdf() {
    try {
        const res = await axios.post('http://localhost:3000/api/public/generate-report', {
            reportData: { id: 'test', patientName: 'Test', testName: 'CBC' },
            labProfile: { name: 'Lab' },
            patientData: { age: 20 },
            doctorData: { name: 'Doc' }
        }, {
            responseType: 'arraybuffer'
        });

        console.log("Status:", res.status);
        console.log("Headers:", res.headers);
        
        const buffer = Buffer.from(res.data);
        console.log("Buffer Length:", buffer.length);
        console.log("First 10 bytes:", buffer.subarray(0, 10).toString('utf-8'));
    } catch (e) {
        console.error("Error:", e.response ? e.response.status : e.message);
        if (e.response && e.response.data) {
             console.error("Error Data:", Buffer.from(e.response.data).toString('utf-8'));
        }
    }
}

testPdf();
