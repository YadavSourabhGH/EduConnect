require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');
const cors = require('cors');
const nodemailer = require('nodemailer');

const app = express();

// Update CORS configuration
app.use((req, res, next) => {
    // Allow any origin
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Credentials', true);

    // Handle OPTIONS request
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    next();
});

// Remove the existing cors middleware since we're handling it manually
// app.use(cors(corsOptions));

// Other middleware
app.use(express.json());

// Remove static file serving
// app.use(express.static(__dirname));

// Add routes to serve HTML pages
app.get('/dashboard', (req, res) => {
    res.sendFile(__dirname + '/dashboard.html');
});

app.get('/quiz', (req, res) => {
    if (!req.query.qs) {
        return res.status(400).send('Missing quiz code');
    }
    res.sendFile(__dirname + '/quiz.html');
});

// Add CORS headers middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST');
    res.header('Access-Control-Allow-Headers', '*');
    next();
});

const PORT = 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_ENDPOINT = 'https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent';

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL,
        pass: process.env.PASSWORD
    },
    tls: {
        rejectUnauthorized: false
    }
});

// Helper function to generate a random unique code
const generateUniqueCode = () => {
    return crypto.randomBytes(6).toString('base64').replace(/[+/=]/g, '').slice(0, 8);
};

// Helper function to fetch questions using Gemini API
const generateQuestions = async (subject, difficulty, numQuestions) => {
    try {
        const prompt = `Generate exactly ${numQuestions} multiple-choice questions on the topic of “${subject}” at a “${difficulty}” difficulty level.

Your response must strictly adhere to the following JSON structure:

[
{
“question”: “Write question here?”,
“A”: “First option”,
“B”: “Second option”,
“C”: “Third option”,
“D”: “Fourth option”,
“correct”: “A” // Correct answer must be one of “A”, “B”, “C”, or “D”.
}
// Repeat for all ${numQuestions} questions
]

Important instructions:
	1.	Strict JSON format: Ensure proper use of commas between objects and no trailing commas.
	2.	Escape special characters: If the question or options contain quotes, escape them using " (e.g., "example").
	3.	No additional text: Return only the JSON array, without any explanations, comments, or surrounding text.
	4.	Consistent structure: Each object in the array must have the exact fields shown above.
	5.	Valid content: Ensure questions and answers are syntactically and contextually correct for the topic and difficulty level.

Example of a valid JSON array:

[
{
“question”: “What is 2 + 2?”,
“A”: “3”,
“B”: “4”,
“C”: “5”,
“D”: “6”,
“correct”: “B”
},
{
“question”: “What is the capital of France?”,
“A”: “Berlin”,
“B”: “Madrid”,
“C”: “Paris”,
“D”: “Rome”,
“correct”: “C”
}
]`;

        const response = await axios.post(GEMINI_API_ENDPOINT, {
            model: "gemini-pro",
            contents: [{
                role: "user",
                parts: [{
                    text: prompt
                }]
            }]
        }, {
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': GEMINI_API_KEY
            }
        });

        const generatedText = response.data.candidates[0].content?.parts?.[0]?.text;
        
        if (!generatedText) {
            throw new Error('Empty response from Gemini API');
        }

        // Extract JSON array
        const jsonMatch = generatedText.match(/\[\s*\{[\s\S]*\}\s*\]/);
        if (!jsonMatch) {
            throw new Error('No valid JSON array found in response');
        }

        // Clean and parse JSON
        const cleanJson = jsonMatch[0]
            .replace(/[\u0000-\u001F]+/g, ' ')
            .replace(/\\/g, '\\\\')
            .replace(/[\u2018\u2019]/g, "'")
            .replace(/[\u201C\u201D]/g, '"')
            .replace(/,(\s*[}\]])/g, '$1'); // Remove trailing commas

        let parsedQuestions;
        try {
            parsedQuestions = JSON.parse(cleanJson);
        } catch (e) {
            console.error('JSON parsing error:', cleanJson);
            throw new Error('Failed to parse questions JSON: ' + e.message);
        }

        return parsedQuestions.map(q => ({
            question: q.question,
            options: [q.A, q.B, q.C, q.D],
            correctAnswer: q[q.correct],
            otherOptions: [q.A, q.B, q.C, q.D].filter(opt => opt !== q[q.correct])
        }));
    } catch (error) {
        console.error('Error generating questions:', error.message);
        return null;
    }
};

// Endpoint 1: Generate questions based on subject, difficulty, and number of questions
app.post('/generate-questions', async (req, res) => {
    const { subject, difficulty, numQuestions } = req.body;

    if (!subject || !difficulty || !numQuestions) {
        return res.status(400).json({ error: 'Missing parameters: subject, difficulty, and numQuestions are required.' });
    }

    try {
        // Generate questions using Gemini API
        const questionsData = await generateQuestions(subject, difficulty, numQuestions);

        if (!questionsData) {
            return res.status(500).json({ error: 'Failed to generate questions.' });
        }

        // Create a unique code to store the questions
        const uniqueCode = generateUniqueCode();

        // Structure the questions with options (dummy structure here)
        const questions = questionsData.map((q, index) => ({
            question: q.question,
            options: q.options, // Assuming API returns options
            correctAnswer: q.correctAnswer,
            otherOptions: q.options.filter(opt => opt !== q.correctAnswer)
        }));

        // Add this before writing the file
        if (!fs.existsSync('./questions')) {
            fs.mkdirSync('./questions');
        }

        // Save questions to a JSON file with the unique code
        const filePath = `./questions/${uniqueCode}.json`;
        fs.writeFileSync(filePath, JSON.stringify({ questions }), 'utf8');

        res.status(200).json({ message: 'Questions generated successfully.', uniqueCode });
    } catch (error) {
        console.error('Error generating questions:', error);
        res.status(500).json({ error: 'An error occurred while generating questions.' });
    }
});

app.post('/send-quiz-email', async (req, res) => {
    const { to, subject, html } = req.body;

    if (!to || !subject || !html) {
        return res.status(400).json({ 
            success: false,
            error: 'Missing required email parameters' 
        });
    }

    try {
        const info = await transporter.sendMail({
            from: `"Quiz System" <${process.env.EMAIL}>`,
            to,
            subject,
            html
        });

        console.log('Email sent: %s', info.messageId);
        
        // Add CORS headers explicitly
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'POST');
        res.header('Access-Control-Allow-Headers', 'Content-Type');
        
        res.json({ 
            success: true,
            messageId: info.messageId 
        });
    } catch (error) {
        console.error('Email error:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to send email',
            details: error.message 
        });
    }
});

// Endpoint 2: Fetch question by unique code and question number
app.get('/get-question', (req, res) => {
    const { uniqueCode, questionNumber } = req.query;

    if (!uniqueCode || !questionNumber) {
        return res.status(400).json({ error: 'Missing parameters: uniqueCode and questionNumber are required.' });
    }

    const filePath = `./questions/${uniqueCode}.json`;

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Questions not found for the given unique code.' });
    }

    const questionsData = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    if (questionNumber < 1 || questionNumber > questionsData.questions.length) {
        return res.status(400).json({ error: 'Invalid question number.' });
    }

    const question = questionsData.questions[questionNumber - 1];
    // Send the question and options, but not the correct answer
    res.status(200).json({
        question: question.question,
        options: question.options,
        questionText: question.question // Add full question text
    });
});

// Endpoint 3: Verify the answer for a given question
app.post('/verify-answer', (req, res) => {
    const { uniqueCode, questionNumber, answer } = req.body;

    if (!uniqueCode || !questionNumber || !answer) {
        return res.status(400).json({ error: 'Missing parameters: uniqueCode, questionNumber, and answer are required.' });
    }

    const filePath = `./questions/${uniqueCode}.json`;

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Questions not found for the given unique code.' });
    }

    const questionsData = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    if (questionNumber < 1 || questionNumber > questionsData.questions.length) {
        return res.status(400).json({ error: 'Invalid question number.' });
    }

    const question = questionsData.questions[questionNumber - 1];
    const isCorrect = answer === question.correctAnswer;

    res.status(200).json({
        isCorrect,
        correctAnswer: question.correctAnswer,
        question: question.question // Add full question text
    });
});

// Endpoint 4: Save results for a student
app.post('/save-results', (req, res) => {
    const { uniqueCode, studentInfo, results } = req.body;
    const resultsPath = `./results/${uniqueCode}_${studentInfo.rollNo}.json`;
    
    if (!fs.existsSync('./results')) {
        fs.mkdirSync('./results');
    }
    
    fs.writeFileSync(resultsPath, JSON.stringify({
        studentInfo,
        results,
        timestamp: new Date()
    }));
    
    res.json({ status: 'Results saved successfully' });
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});