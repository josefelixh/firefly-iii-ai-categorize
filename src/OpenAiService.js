import { Configuration, OpenAIApi } from "openai";
import { getConfigVariable } from "./util.js";
import logger from "./logger.js";

export default class OpenAiService {
    #openAi;
    #model;
    #firefly;

    constructor(fireflyService) {
        const apiKey = getConfigVariable("OPENAI_API_KEY");
        this.#model = getConfigVariable("OPENAI_MODEL");
        this.#firefly = fireflyService; // Assign FireflyService instance

        logger.info("🔍 OpenAI Model:", this.#model);
        logger.info("🔐 OpenAI API Key Set:", apiKey ? "✅ Yes" : "❌ No");

        const configuration = new Configuration({ apiKey });
        this.#openAi = new OpenAIApi(configuration);
    }

    async classify(categories, budgets, transaction) {
        try {
            const categoryPrompt = await this.#generateCategoryPrompt(categories, transaction);
            logger.debug("📤 Sending OpenAI Request for Category:", { model: this.#model, prompt: categoryPrompt });

            const categoryResponse = await this.#openAi.createChatCompletion({
                model: this.#model,
                messages: [{ role: "user", content: categoryPrompt }]
            });

            let categoryGuess = categoryResponse.data?.choices?.[0]?.message?.content?.trim() || null;
            if (!categoryGuess || !categories.includes(categoryGuess)) {
                logger.warn(`⚠️ OpenAI could not confidently classify category: ${categoryGuess}`);
                categoryGuess = null;
            }

            const budgetPrompt = await this.#generateBudgetPrompt(budgets, transaction);
            logger.debug("📤 Sending OpenAI Request for Budget:", { model: this.#model, prompt: budgetPrompt });

            const budgetResponse = await this.#openAi.createChatCompletion({
                model: this.#model,
                messages: [{ role: "user", content: budgetPrompt }]
            });

            let budgetGuess = budgetResponse.data?.choices?.[0]?.message?.content?.trim() || null;
            if (!budgetGuess || !budgets.includes(budgetGuess)) {
                logger.warn(`⚠️ OpenAI could not confidently classify budget: ${budgetGuess}`);
                budgetGuess = null;
            }

            return {
                category: categoryGuess,
                prompt: categoryPrompt,
                response: categoryResponse.data.choices[0].message.content,
                budget: budgetGuess,
                budgetPrompt: budgetPrompt,
                budgetResponse: budgetResponse.data.choices[0].message.content,
            };

        } catch (error) {
            logger.error("❌ OpenAI API Error:", {
                message: error.message,
                status: error.response?.status || "Unknown Status",
                data: error.response?.data || "No Response Data",
                stack: error.stack
            });
            throw new OpenAiException(error.response?.status, error.response, error.response?.data || error.message);
        }
    }

    async #generateBudgetPrompt(budgets, transaction) {
        const manualBudgets = await this.#firefly.getManuallyBudgetedTransactions();
        let budgetExamples = "";

        if (manualBudgets.length > 0) {
            budgetExamples = manualBudgets.map(b =>
                `    - A transaction from "${b.merchant}" with description "${b.description}" for "${b.amount} ${b.currency_code}"  was manually assigned to the "${b.assignedBudget}" budget. ${b.note ? "Note: " + b.note.replace(/\n+/g, " - ").trim() : ""}`
            ).join("\n");
        }

        return `I want to assign transactions to one of the following budgets:
    ${budgets.join(", ")}.

    Here are examples of past transactions that were manually assigned a budget:
${budgetExamples}

    Given the following transaction details:
    - **Merchant Name:** "${transaction.destination_name}"
    - **Transaction Description:** "${transaction.description}"
    - **Transaction Amount:** "${transaction.amount} ${transaction.currency_code}"
    - **Transaction Type:** "${transaction.type}"

    Please determine the most appropriate budget from the list. If no budget applies, respond with "No Budget".

    Just output the **budget name only**, nothing else.`;
    }

    async #generateCategoryPrompt(categories, transaction) {
        const corrections = await this.#firefly.getManuallyCategorizedTransactions();
        let correctionExamples = "";

        if (corrections.length > 0) {
            correctionExamples = corrections.map(c =>
                `    - A transaction from "${c.merchant}" with description "${c.description}" for "${c.amount} ${c.currency_code}" was manually categorized as "${c.correctedCategory}". ${c.note ? "Note: " + c.note.replace(/\n+/g, " - ").trim() : ""}`
            ).join("\n");
        }

        return `I want to categorize my bank transactions based on these categories: 
    ${categories.join(", ")}.

    Here are examples of past transactions that were manually categorized:
${correctionExamples}

    Given the following transaction details:
    - **Merchant Name:** "${transaction.destination_name}"
    - **Transaction Description:** "${transaction.description}"
    - **Transaction Amount:** "${transaction.amount} ${transaction.currency_code}"
    - **Transaction Type:** "${transaction.type}"

    Please determine the most appropriate category from the list. If the description does not contain enough information, base your decision on the merchant name and amount. If multiple categories could apply, choose the best match. If no suitable category exists, pick the closest relevant one rather than saying "Neither."

    Just output the **category name only**, nothing else.`;
    }
}

class OpenAiException extends Error {
    code;
    response;
    body;

    constructor(statusCode, response, body) {
        super(`Error while communicating with OpenAI: ${statusCode} - ${body}`);

        this.code = statusCode;
        this.response = response;
        this.body = body;
    }
}