const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '.env');
let content = fs.readFileSync(envPath, 'utf8');
// Replace triple backslashes followed by n with single backslash n
content = content.replace(/\\\\\\n/g, '\\n'); 
fs.writeFileSync(envPath, content);
console.log('Fixed .env');
