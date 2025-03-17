import express from "express";
import { getConfigVariable } from "./util.js";
import FireflyService from "./FireflyService.js";
import OpenAiService from "./OpenAiService.js";
import { Server } from "socket.io";
import * as http from "http";
import Queue from "queue";
import JobList from "./JobList.js";
import logger from "./logger.js";

export default class App {
    #PORT;
    #ENABLE_UI;

    #firefly;
    #openAi;

    #server;
    #io;
    #express;

    #queue;
    #jobList;


    constructor() {
        this.#PORT = getConfigVariable("PORT", '3000');
        this.#ENABLE_UI = getConfigVariable("ENABLE_UI", 'false') === 'true';
    }

    async run() {
        this.#firefly = new FireflyService();
        this.#openAi = new OpenAiService(this.#firefly);

        this.#queue = new Queue({
            timeout: 30 * 1000,
            concurrency: 1,
            autostart: true
        });

        this.#queue.addEventListener('start', job => logger.debug("🚀 Job Started →", job));
        this.#queue.addEventListener('success', event => logger.debug("✅ Job Completed Successfully →", event.job));
        this.#queue.addEventListener('error', event => {
            logger.error("🚨 Job Error!");
            logger.error("🔍 Job Details:", event.job);
            logger.error("❌ Error Message:", event.err?.message || "No error message");
            logger.error("📜 Stack Trace:", event.err?.stack || "No stack trace");
        });
        this.#queue.addEventListener('timeout', event => logger.error('❌ Job timeout', event.job))

        this.#express = express();
        this.#server = http.createServer(this.#express)
        this.#io = new Server(this.#server)

        this.#jobList = new JobList();
        this.#jobList.on('job created', data => this.#io.emit('job created', data));
        this.#jobList.on('job updated', data => this.#io.emit('job updated', data));

        this.#express.use(express.json());

        if (this.#ENABLE_UI) {
            this.#express.use('/', express.static('public'))
        }

        this.#express.post('/webhook', this.#onWebhook.bind(this))

        this.#server.listen(this.#PORT, async () => {
            logger.info(`🚀 Application running on port ${this.#PORT}`);
        });

        this.#io.on('connection', socket => {
            logger.debug('🔍 Socket connection');
            socket.emit('jobs', Array.from(this.#jobList.getJobs().values()));
        })
    }

    #onWebhook(req, res) {
        try {
            logger.info("🌐 Incoming Webhook Received!");
            this.#handleWebhook(req, res);
            res.status(202).send("Queued");
        } catch (e) {
            logger.error("🚨 Webhook Processing Error:", e);

            if (e instanceof WebhookException) {
                logger.info("🚫 Skipping transaction:", e.message);
                res.status(200).send(`Skipped: ${e.message}`);
            } else {
                logger.error("❌ Server Error:", e.message);
                res.status(500).send("Internal Server Error. Check logs for details.");
            }
        }
    }

    #handleWebhook(req, res) {
        // TODO: validate auth

        if (req.body?.trigger !== "STORE_TRANSACTION") {
            throw new WebhookException("trigger is not STORE_TRANSACTION. Request will not be processed");
        }

        if (req.body?.response !== "TRANSACTIONS") {
            throw new WebhookException("trigger is not TRANSACTION. Request will not be processed");
        }

        if (!req.body?.content?.id) {
            throw new WebhookException("Missing content.id");
        }

        if (req.body?.content?.transactions?.length === 0) {
            throw new WebhookException("No transactions are available in content.transactions");
        }


        const transaction = req.body.content.transactions[0];

        if (transaction.type !== "withdrawal") {
            throw new WebhookException("content.transactions[0].type has to be 'withdrawal'. Transaction will be ignored.");
        }
        // Ignore transactions that have the "pending" tag
        if (transaction.tags && transaction.tags.includes("pending")) {
            throw new WebhookException("Transaction has the 'pending' tag and will be ignored.");
        }

        const shouldCategorize = transaction.category_id === null || transaction.category_id === "";
        const shouldBudget = transaction.budget_id === null || transaction.budget_id === "" || transaction.type != "withdrawal";

        if (!shouldCategorize && !shouldBudget) {
            throw new WebhookException("Transaction already has both category and budget set. It will be ignored.");
        }

        if (!transaction.description) {
            throw new WebhookException("Missing content.transactions[0].description");
        }

        if (!transaction.destination_name) {
            throw new WebhookException("Missing content.transactions[0].destination_name");
        }

        const destinationName = transaction.destination_name;
        const description = transaction.description

        const job = this.#jobList.createJob({
            destinationName,
            description
        });

        this.#queue.push(async () => {
            try {
                logger.info("🛠️ Job started:", job.id, " | Should Categorize:", shouldCategorize, " | Should Budget:", shouldBudget);
                this.#jobList.setJobInProgress(job.id);

                const categories = await this.#firefly.getCategories();
                const budgets = await this.#firefly.getBudgets();
                logger.debug("📂 Categories retrieved:", categories);
                logger.debug("📂 Budgets retrieved:", budgets);

                const classification = await this.#openAi.classify(
                    Array.from(categories.keys()), Array.from(budgets.keys()), transaction
                ) || {};

                const category = classification.category || null;
                const budget = classification.budget || null;
                const prompt = classification.prompt || "";
                const response = classification.response || "";
                const budgetPrompt = classification.budgetPrompt || "";
                const budgetResponse = classification.budgetResponse || "";

                logger.debug("🤖 OpenAI Response:", { category, budget, prompt, response, budgetPrompt, budgetResponse });

                const categoryToSet = shouldCategorize && category && category !== "Neither" ? categories.get(category) : null;
                const budgetToSet = shouldBudget && budget && budget !== "No Budget" ? budgets.get(budget) : null;

                if (categoryToSet || budgetToSet) {
                    logger.info("📝 Updating Firefly transaction...");
                    await this.#firefly.setCategoryAndBudget(
                        req.body.content.id,
                        req.body.content.transactions,
                        categoryToSet,
                        budgetToSet
                    );
                } else {
                    logger.info("🚫 No updates needed for Firefly.");
                }

                const newData = Object.assign({}, job.data);
                newData.category = category;
                newData.budget = budget;
                newData.prompt = prompt;
                newData.response = response;
                newData.budgetPrompt = budgetPrompt;
                newData.budgetResponse = budgetResponse;
                this.#jobList.updateJobData(job.id, newData);

                this.#jobList.setJobFinished(job.id);
                logger.info("✅ Job Finished:", job.id);
            } catch (error) {
                logger.error("🚨 Job Processing Error:", error);
                throw error; // Ensure the queue catches and logs the error
            }
        });
    }
}

class WebhookException extends Error {

    constructor(message) {
        super(message);
    }
}