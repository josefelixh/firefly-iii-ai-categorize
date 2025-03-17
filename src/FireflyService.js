import { getConfigVariable } from "./util.js";
import logger from "./logger.js";

export default class FireflyService {
    #BASE_URL;
    #PERSONAL_TOKEN;

    constructor() {
        this.#BASE_URL = getConfigVariable("FIREFLY_URL")
        if (this.#BASE_URL.slice(-1) === "/") {
            this.#BASE_URL = this.#BASE_URL.substring(0, this.#BASE_URL.length - 1)
        }

        this.#PERSONAL_TOKEN = getConfigVariable("FIREFLY_PERSONAL_TOKEN")
    }

    async getBudgets() {
        const response = await fetch(`${this.#BASE_URL}/api/v1/budgets`, {
            headers: {
                Authorization: `Bearer ${this.#PERSONAL_TOKEN}`,
            }
        });

        if (!response.ok) {
            throw new FireflyException(response.status, response, await response.text());
        }

        const data = await response.json();
        const budgets = new Map();
        data.data.forEach(budget => {
            budgets.set(budget.attributes.name, budget.id);
        });

        return budgets;
    }


    async getCategories() {
        const response = await fetch(`${this.#BASE_URL}/api/v1/categories`, {
            headers: {
                Authorization: `Bearer ${this.#PERSONAL_TOKEN}`,
            }
        });

        if (!response.ok) {
            throw new FireflyException(response.status, response, await response.text())
        }

        const data = await response.json();

        const categories = new Map();
        data.data.forEach(category => {
            categories.set(category.attributes.name, category.id);
        });

        return categories;
    }

    async getManuallyCategorizedTransactions() {
        const tag = "Manually Categorised"; // Ensure this matches the actual tag used in Firefly
        const response = await fetch(`${this.#BASE_URL}/api/v1/tags/${encodeURIComponent(tag)}/transactions?limit=50`, {
            headers: {
                Authorization: `Bearer ${this.#PERSONAL_TOKEN}`,
            }
        });

        if (!response.ok) {
            throw new FireflyException(response.status, response, await response.text());
        }

        const data = await response.json();
        logger.debug("🔍 Tags Firefly API Response:", JSON.stringify(data, null, 2));
        const uniqueCorrections = new Map();

        data.data.forEach(entry => {
            if (!entry.attributes || !Array.isArray(entry.attributes.transactions)) return; // Ensure transactions exist

            entry.attributes.transactions.forEach(transaction => {
                const merchant = transaction.destination_name || "Unknown Merchant";
                const description = transaction.description || "No description";
                const correctedCategory = transaction.category_name || "Unknown";
                const note = transaction.notes || "";

                const key = `${merchant}-${description}`;
                if (!uniqueCorrections.has(key)) {
                    uniqueCorrections.set(key, { merchant, description, correctedCategory, note });
                }
            });
        });

        return Array.from(uniqueCorrections.values()).slice(0, 10);
    }

    async getManuallyBudgetedTransactions() {
        const tag = "Manually Budgeted"; // Ensure this matches the actual tag in Firefly
        const response = await fetch(`${this.#BASE_URL}/api/v1/tags/${encodeURIComponent(tag)}/transactions?limit=50`, {
            headers: {
                Authorization: `Bearer ${this.#PERSONAL_TOKEN}`,
            }
        });

        if (!response.ok) {
            throw new FireflyException(response.status, response, await response.text());
        }

        const data = await response.json();
        logger.debug("🔍 Budget Tags Firefly API Response:", JSON.stringify(data, null, 2));

        const uniqueBudgets = new Map();

        data.data.forEach(entry => {
            if (!entry.attributes || !Array.isArray(entry.attributes.transactions)) return;

            entry.attributes.transactions.forEach(transaction => {
                const merchant = transaction.destination_name || "Unknown Merchant";
                const description = transaction.description || "No description";
                const assignedBudget = transaction.budget_name || "Unknown";

                const key = `${merchant}-${description}`;
                if (!uniqueBudgets.has(key)) {
                    uniqueBudgets.set(key, { merchant, description, assignedBudget });
                }
            });
        });

        return Array.from(uniqueBudgets.values()).slice(0, 10);
    }

    async setCategoryAndBudget(transactionId, transactions, categoryId, budgetId) {
        const categoryTag = getConfigVariable("FIREFLY_TAG", "AI categorized");
        const budgetTag = getConfigVariable("FIREFLY_TAG_BUDGET", "AI Budgeted");

        const body = {
            apply_rules: true,
            fire_webhooks: true,
            transactions: [],
        };

        transactions.forEach(transaction => {
            let tags = transaction.tags || [];
            if (categoryId) {
                tags.push(categoryTag);
            }
            if (budgetId) {
                tags.push(budgetTag)
            }

            const updatedTransaction = {
                transaction_journal_id: transaction.transaction_journal_id,
                tags: tags
            };

            if (categoryId && transaction.category_id !== categoryId) {
                updatedTransaction.category_id = categoryId;
            }
            if (budgetId && transaction.budget_id !== budgetId) {
                updatedTransaction.budget_id = budgetId;
            }

            body.transactions.push(updatedTransaction);
        });

        const response = await fetch(`${this.#BASE_URL}/api/v1/transactions/${transactionId}`, {
            method: "PUT",
            headers: {
                Authorization: `Bearer ${this.#PERSONAL_TOKEN}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            throw new FireflyException(response.status, response, await response.text());
        }

        const categoryMsg = categoryId ? "Category updated" : "Category unchanged";
        const budgetMsg = budgetId ? "Budget updated" : "Budget unchanged";
        logger.info(`✅ Transaction updated: ${categoryMsg}, ${budgetMsg}`);
    }
}

class FireflyException extends Error {
    code;
    response;
    body;

    constructor(statusCode, response, body) {
        super(`Error while communicating with Firefly III: ${statusCode} - ${body}`);

        this.code = statusCode;
        this.response = response;
        this.body = body;
    }
}