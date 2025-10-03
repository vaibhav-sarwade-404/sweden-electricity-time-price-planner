const TARGET_CURRENCY_UNIT = "SEK/kWh";
const API_BASE_URL = "https://www.elprisetjustnu.se/api/v1/prices/";
const CACHE_KEY = "electricity_prices_cache";
const CHART_COLORS = {
  base: "rgb(59, 130, 246)", // Blue-500
  highlight: "rgb(22, 163, 74)", // Green-700
  background: "rgba(59, 130, 246, 0.1)",
};
const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=";
const API_KEY = ""; // Placeholder for Canvas environment injection

let priceChartInstance = null; // Holds the Chart.js instance
let lastCalculatedSlots = []; // Global state to pass slots to the LLM assistant
let lastCalculatedUserFees = {}; // Global state for fee context

// --- DOM Elements ---
const priceZoneSelect = document.getElementById("priceZone");
const minutesNeededInput = document.getElementById("minutesNeeded");
const topSlotsNeededInput = document.getElementById("topSlotsNeeded");
const timeSlotSelect = document.getElementById("timeSlot");
const gridFeeInput = document.getElementById("gridFee");
const energyTaxInput = document.getElementById("energyTax");
const vatPercentageInput = document.getElementById("vatPercentage");
const calculateButton = document.getElementById("calculateButton");
const messageBox = document.getElementById("message-box");
const slotResultsContainer = document.getElementById("slot-results-container");
const loadingSpinner = document.getElementById("loading-spinner");
const dataStatusBox = document.getElementById("data-status");
const currentTimeDisplay = document.getElementById("current-time");
const disclaimerNote = document.getElementById("disclaimer-note");
const chartContainer = document.getElementById("chart-container");
const priceChartCanvas = document.getElementById("priceChart");

// LLM Elements
const strategyGeneratorContainer = document.getElementById(
  "strategy-generator-container"
);
const taskInput = document.getElementById("taskInput");
const generateStrategyButton = document.getElementById(
  "generateStrategyButton"
);
const strategyOutput = document.getElementById("strategyOutput");
const geminiLoadingSpinner = document.getElementById("gemini-loading-spinner");

// --- Utility Functions ---

/**
 * Updates the current time display in the UI.
 */
function updateCurrentTime() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString("sv-SE", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
  currentTimeDisplay.textContent = timeStr;
}

/**
 * Helper to format Date objects for the API URL: YYYY/MM-DD_ZONE.json
 */
function getApiUrl(date, zone) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${API_BASE_URL}${year}/${month}-${day}_${zone}.json`;
}

/**
 * Applies user-defined fees and VAT to a base price.
 */
function applyUserFees(basePrice, vat, energyTax, gridFee) {
  const totalFixedFee = energyTax + gridFee;
  let priceBeforeVAT = basePrice + totalFixedFee;
  const finalPrice = priceBeforeVAT * (1 + vat / 100);
  return finalPrice;
}

/**
 * Parses the raw API price data and annotates them, applying user fees.
 */
function parsePriceData(rawData, userFees) {
  if (!Array.isArray(rawData) || rawData.length === 0) {
    return [];
  }
  const now = new Date();
  const nowTime = now.getTime();

  return rawData
    .map((item, index) => {
      const timestamp = new Date(item.time_start);

      const finalPrice = applyUserFees(
        item.SEK_per_kWh,
        userFees.vat,
        userFees.energyTax,
        userFees.gridFee
      );

      const dayTag = timestamp.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });

      return {
        id: timestamp.getTime(),
        timestamp: timestamp,
        base_price: item.SEK_per_kWh,
        calculated_price: finalPrice,
        isPast: timestamp.getTime() < nowTime,
        dayTag: dayTag,
        available: true,
      };
    })
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

/**
 * Fetches prices for a single day with exponential backoff.
 */
async function fetchPrices(date, zone, maxRetries = 3) {
  const url = getApiUrl(date, zone);
  const dateStr = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url);

      if (response.status === 404) {
        return {
          rawData: null,
          status: `Prices for ${dateStr} not yet released (404).`,
        };
      }

      if (response.ok) {
        const rawData = await response.json();
        return {
          rawData: rawData,
          status: `Prices for ${dateStr} successfully loaded (${rawData.length} periods).`,
        };
      }

      throw new Error(`HTTP error! Status: ${response.status}`);
    } catch (error) {
      console.error(
        `[Fetch Attempt ${attempt + 1}] Error fetching ${dateStr}:`,
        error.message
      );
      if (attempt === maxRetries - 1) {
        return {
          rawData: null,
          status: `Failed to load prices for ${dateStr}. Network error.`,
        };
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.pow(2, attempt) * 1000)
      );
    }
  }
  return {
    rawData: null,
    status: `Failed to load prices for ${dateStr} after retries.`,
  };
}

/**
 * Checks local storage cache first, then fetches if data is missing or stale.
 */
async function checkCacheAndFetchPrices(zone) {
  const today = new Date();
  const todayDateStr = today.toISOString().split("T")[0];

  let cachedData;
  try {
    const cacheStr = localStorage.getItem(CACHE_KEY);
    if (cacheStr) {
      cachedData = JSON.parse(cacheStr);
    }
  } catch (e) {
    console.error("Error reading cache:", e);
  }

  // Check cache validity: must exist, be for the current zone, and cover today's date
  if (
    cachedData &&
    cachedData.zone === zone &&
    cachedData.dateFetched === todayDateStr
  ) {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const statusMessage = `Today: ✅ Cached. Tomorrow: ✅ Cached.`;

    const allRawPrices = [...cachedData.today, ...cachedData.tomorrow].sort(
      (a, b) =>
        new Date(a.time_start).getTime() - new Date(b.time_start).getTime()
    );

    return {
      allRawPrices: allRawPrices,
      statusMessage: statusMessage,
      isCached: true,
    };
  }

  // Fetch new data (Today and Tomorrow)
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const [todayResult, tomorrowResult] = await Promise.all([
    fetchPrices(today, zone),
    fetchPrices(tomorrow, zone),
  ]);

  let statusMessage = [
    `Today: ${todayResult.status}`,
    `Tomorrow: ${tomorrowResult.status}`,
  ].join(" | ");

  const todayRaw = todayResult.rawData || [];
  const tomorrowRaw = tomorrowResult.rawData || [];

  const allRawPrices = [...todayRaw, ...tomorrowRaw].sort(
    (a, b) =>
      new Date(a.time_start).getTime() - new Date(b.time_start).getTime()
  );

  // Save to cache if data was successfully fetched for today and tomorrow
  if (todayRaw.length > 0 && tomorrowRaw.length > 0) {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        dateFetched: todayDateStr,
        zone: zone,
        today: todayRaw,
        tomorrow: tomorrowRaw,
      })
    );
    statusMessage += ` | Data successfully cached.`;
  } else {
    statusMessage += ` | Warning: Partial data. Not caching.`;
  }

  return { allRawPrices, statusMessage, isCached: false };
}

/**
 * Finds the top N best *non-overlapping* consecutive hour blocks (Greedy Strategy).
 */
function findTopBestTimeSlots(availablePrices, hours, numSlots) {
  const periodsNeeded = hours * 4;
  const bestSlots = [];

  const workingPrices = JSON.parse(JSON.stringify(availablePrices));
  workingPrices.forEach((p) => {
    p.timestamp = new Date(p.timestamp);
    p.available = true;
  });

  for (let k = 0; k < numSlots; k++) {
    let cheapestCost = Infinity;
    let bestBlockStartIndex = -1;
    let bestBlockEndIndex = -1;

    const availableIndices = workingPrices
      .map((p, index) => (p.available ? index : -1))
      .filter((index) => index !== -1);

    if (availableIndices.length < periodsNeeded) {
      break;
    }

    for (let i = 0; i <= availableIndices.length - periodsNeeded; i++) {
      const blockStartOriginalIndex = availableIndices[i];
      const blockEndOriginalIndex = availableIndices[i + periodsNeeded - 1];

      if (
        blockEndOriginalIndex - blockStartOriginalIndex ===
        periodsNeeded - 1
      ) {
        const currentBlock = workingPrices.slice(
          blockStartOriginalIndex,
          blockEndOriginalIndex + 1
        );
        const currentCost = currentBlock.reduce(
          (sum, p) => sum + p.calculated_price,
          0
        );

        if (currentCost < cheapestCost) {
          cheapestCost = currentCost;
          bestBlockStartIndex = blockStartOriginalIndex;
          bestBlockEndIndex = blockEndOriginalIndex;
        }
      }
    }

    if (bestBlockStartIndex !== -1) {
      const bestBlock = workingPrices.slice(
        bestBlockStartIndex,
        bestBlockEndIndex + 1
      );
      const startTime = bestBlock[0].timestamp;
      const endTime = bestBlock[bestBlock.length - 1].timestamp;
      const totalCost = cheapestCost;
      const avgPrice = cheapestCost / periodsNeeded;

      bestSlots.push({
        rank: k + 1,
        startTime: startTime,
        endTime: new Date(endTime.getTime() + 15 * 60000),
        averagePrice: avgPrice,
        totalCost: totalCost,
        periods: bestBlock,
      });

      for (let i = bestBlockStartIndex; i <= bestBlockEndIndex; i++) {
        workingPrices[i].available = false;
      }
    } else {
      break;
    }
  }

  return bestSlots;
}

/**
 * Renders the price chart using Chart.js with highlighted slots.
 */
function renderPriceChart(allPrices, bestSlots) {
  chartContainer.classList.remove("hidden");

  const labels = allPrices.map((p) => {
    const time = p.timestamp.toLocaleTimeString("sv-SE", {
      hour: "2-digit",
      minute: "2-digit",
    });
    const day = p.dayTag.split(" ")[0];
    return `${day} ${time}`;
  });
  const prices = allPrices.map((p) => p.calculated_price);

  const highlightData = allPrices.map(() => null);
  const bestSlotTimestamps = new Set();

  bestSlots.forEach((slot) => {
    slot.periods.forEach((p) => {
      bestSlotTimestamps.add(new Date(p.timestamp).getTime());
    });
  });

  allPrices.forEach((p, index) => {
    if (bestSlotTimestamps.has(p.timestamp.getTime())) {
      highlightData[index] = p.calculated_price;
    }
  });

  if (priceChartInstance) {
    priceChartInstance.destroy();
  }

  const ctx = priceChartCanvas.getContext("2d");
  priceChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        {
          label: "Calculated Price (SEK/kWh)",
          data: prices,
          borderColor: CHART_COLORS.base,
          backgroundColor: CHART_COLORS.background,
          borderWidth: 2,
          pointRadius: 2,
          tension: 0.2,
          fill: true,
          yAxisID: "y",
        },
        {
          label: "Cheapest Slot Highlight",
          data: highlightData,
          borderColor: CHART_COLORS.highlight,
          backgroundColor: CHART_COLORS.highlight,
          pointRadius: 7,
          pointBackgroundColor: CHART_COLORS.highlight,
          pointBorderColor: "#fff",
          pointBorderWidth: 2,
          showLine: false,
          yAxisID: "y",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: function (context) {
              return labels[context[0].dataIndex];
            },
            label: function (context) {
              return `Price: ${context.formattedValue} ${TARGET_CURRENCY_UNIT}`;
            },
          },
        },
      },
      scales: {
        y: {
          type: "linear",
          display: true,
          position: "left",
          title: {
            display: true,
            text: `Price (${TARGET_CURRENCY_UNIT})`,
          },
          beginAtZero: true,
        },
        x: {
          ticks: {
            maxRotation: 90,
            minRotation: 90,
            autoSkip: true,
            maxTicksLimit: 12,
          },
          grid: {
            display: false,
          },
        },
      },
    },
  });
}

function renderSlot(slot) {
  const dayTag = slot.periods[0].dayTag;
  const timeOptions = {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Stockholm",
  };
  const startTimeStr = slot.startTime.toLocaleTimeString("sv-SE", timeOptions);
  const endTimeStr = slot.endTime.toLocaleTimeString("sv-SE", timeOptions);

  const rankClass =
    slot.rank === 1
      ? "bg-green-100 border-green-400"
      : "bg-blue-50 border-blue-200";
  const priceColor = slot.rank === 1 ? "text-green-800" : "text-blue-700";
  const hours = slot.periods.length / 4;

  const priceDetails = slot.periods
    .map((p) => {
      const time = p.timestamp.toLocaleTimeString("sv-SE", timeOptions);
      const price = p.calculated_price.toFixed(4);
      const basePrice = p.base_price.toFixed(4);
      return `<li class="text-xs">
                    ${time}: <span class="font-semibold">${price} ${TARGET_CURRENCY_UNIT}</span> (Spot: ${basePrice} SEK)
                </li>`;
    })
    .join("");

  return `
                <div class="p-4 rounded-lg border shadow-lg ${rankClass} transition-shadow duration-300 hover:shadow-xl">
                    <h3 class="font-extrabold text-xl mb-1 flex items-center justify-between">
                        <span class="text-gray-700">#${
                          slot.rank
                        } Best Slot (${hours} Hours)</span>
                        <span class="text-sm font-semibold px-2 py-1 rounded-full ${
                          slot.rank === 1 ? "bg-green-300" : "bg-blue-200"
                        } text-gray-800">${dayTag}</span>
                    </h3>
                    
                    <p class="font-extrabold text-3xl ${priceColor} mt-1">${startTimeStr} - ${endTimeStr}</p>
                    <p class="mt-2 text-lg text-gray-600">
                        <span class="font-semibold">Total Cost (per 1 kWh/period):</span> 
                        <span class="font-extrabold ${priceColor}">${slot.totalCost.toFixed(
    4
  )} SEK</span>
                    </p>
                    <p class="text-lg text-gray-600">
                        <span class="font-semibold">Average Calculated Price:</span> 
                        <span class="font-extrabold ${priceColor}">${slot.averagePrice.toFixed(
    4
  )} ${TARGET_CURRENCY_UNIT}</span>
                    </p>

                    <details class="mt-4 cursor-pointer">
                        <summary class="text-sm text-gray-600 hover:text-gray-800 font-medium">Show 15-Min Price Breakdown (Calculated vs. Spot)</summary>
                        <ul class="list-disc list-inside mt-2 max-h-40 overflow-y-auto bg-white p-2 rounded border border-gray-100 space-y-0">
                            ${priceDetails}
                        </ul>
                    </details>
                </div>
            `;
}

// --- LLM Logic ---

/**
 * Calls the Gemini API with exponential backoff.
 */
async function callGeminiApi(payload, maxRetries = 3) {
  const url = `${GEMINI_API_URL}${API_KEY}`;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const result = await response.json();
        const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return text;
        throw new Error("Gemini response structure invalid or empty.");
      } else if (response.status === 429) {
        // Too many requests - retry
        throw new Error("Rate limit exceeded.");
      } else {
        // Other HTTP error
        throw new Error(`Gemini API HTTP error: ${response.status}`);
      }
    } catch (error) {
      console.warn(`[Gemini Attempt ${attempt + 1}] Error: ${error.message}`);
      if (attempt === maxRetries - 1) {
        throw new Error(
          "Failed to get response from AI assistant after multiple retries."
        );
      }
      // Wait with exponential backoff
      await new Promise((resolve) =>
        setTimeout(resolve, Math.pow(2, attempt) * 1000)
      );
    }
  }
}

/**
 * Formats context and calls the Gemini API for optimization advice.
 */
async function handleStrategyGeneration() {
  const userTasks = taskInput.value.trim();

  if (!userTasks) {
    strategyOutput.innerHTML = `<p class="text-red-600 font-bold">Please enter your energy tasks first (e.g., "Run washing machine for 2 hours").</p>`;
    return;
  }
  if (lastCalculatedSlots.length === 0) {
    strategyOutput.innerHTML = `<p class="text-red-600 font-bold">Please run the main price calculation first to find the cheapest slots.</p>`;
    return;
  }

  // Start loading state
  generateStrategyButton.disabled = true;
  geminiLoadingSpinner.classList.remove("hidden");
  strategyOutput.innerHTML =
    '<p class="text-purple-600 font-bold">Analyzing tasks and generating optimal schedule...</p>';

  try {
    // 1. Prepare Context
    const timeOptions = {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Stockholm",
    };
    const slotsContext = lastCalculatedSlots
      .map((slot) => {
        const startTimeStr = slot.startTime.toLocaleTimeString(
          "sv-SE",
          timeOptions
        );
        const endTimeStr = slot.endTime.toLocaleTimeString(
          "sv-SE",
          timeOptions
        );
        const dateStr = slot.startTime.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        });
        const avgPrice = slot.averagePrice.toFixed(4);
        const hours = slot.periods.length / 4;

        return `Rank #${slot.rank} (${hours} hours): ${dateStr} from ${startTimeStr} to ${endTimeStr}. Average Price (incl. fees): ${avgPrice} ${TARGET_CURRENCY_UNIT}.`;
      })
      .join("\n");

    const feesContext = `User's applied fees are: Grid Fee: ${lastCalculatedUserFees.gridFee} SEK/kWh, Energy Tax: ${lastCalculatedUserFees.energyTax} SEK/kWh, VAT: ${lastCalculatedUserFees.vat}%.`;

    const systemPrompt = `You are an expert energy consultant specializing in Nordic spot market optimization. Your goal is to help the user schedule their energy-intensive tasks into the provided cheapest time slots to minimize costs. 
                
                Instructions:
                1. Based on the user's input, allocate their tasks (like running a machine for a specific duration) into the available cheapest slots provided in the context.
                2. Prioritize the lower ranked (cheaper) slots first.
                3. Provide the advice in a clear, markdown-formatted list with specific time recommendations.
                4. Conclude with a very brief summary of the potential cost benefit (e.g., "You utilized the two cheapest slots.").`;

    const userQuery = `My available cheapest time slots are (Rank #1 is cheapest):\n${slotsContext}\n\n${feesContext}\n\nI need to perform these tasks. Please generate the optimal schedule for me:\n"${userTasks}"`;

    // 2. Call API
    const payload = {
      contents: [{ parts: [{ text: userQuery }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
    };

    const aiResponse = await callGeminiApi(payload);

    // 3. Render Result
    strategyOutput.innerHTML = aiResponse;
  } catch (error) {
    console.error("Gemini Assistant Error:", error);
    strategyOutput.innerHTML = `<p class="text-red-600 font-bold">❌ Error generating strategy: ${error.message}. Please check your task details and try again.</p>`;
  } finally {
    // End loading state
    generateStrategyButton.disabled = false;
    geminiLoadingSpinner.classList.add("hidden");
  }
}

async function handleCalculate() {
  updateCurrentTime();

  const zone = priceZoneSelect.value;
  const minutesNeeded = parseInt(minutesNeededInput.value);
  const topSlotsNeeded = parseInt(topSlotsNeededInput.value);
  const slotValue = timeSlotSelect.value;
  const [startHour, endHour] = slotValue.split("-").map(Number);

  // Save the selected inputs to localStorage for persistence
  localStorage.setItem(
    "userPreferences",
    JSON.stringify({
      zone,
      minutesNeeded,
      topSlotsNeeded,
      timeSlot: slotValue,
      gridFee: gridFeeInput.value,
      energyTax: energyTaxInput.value,
      vatPercentage: vatPercentageInput.value,
    })
  );

  // Get user-defined fees
  const userFees = {
    gridFee: parseFloat(gridFeeInput.value) || 0,
    energyTax: parseFloat(energyTaxInput.value) || 0,
    vat: parseFloat(vatPercentageInput.value) || 0,
  };

  const totalMaxHours = 48;

  // Input Validation
  if (
    minutesNeeded < 15 ||
    minutesNeeded > totalMaxHours * 60 ||
    isNaN(minutesNeeded)
  ) {
    messageBox.innerHTML = `<p class="text-red-600 font-bold">Please select a valid duration between 15 minutes and 48 hours.</p>`;
    slotResultsContainer.innerHTML = "";
    chartContainer.classList.add("hidden");
    strategyGeneratorContainer.classList.add("hidden");
    return;
  }

  // Start loading state
  calculateButton.disabled = true;
  loadingSpinner.classList.remove("hidden");
  messageBox.innerHTML =
    '<p class="text-blue-600 font-bold">Checking cache and fetching 48-hour price data. One moment...</p>';
  slotResultsContainer.innerHTML = "";
  // Immediately hide status box and LLM container for seamless start
  dataStatusBox.classList.add("hidden");
  strategyGeneratorContainer.classList.add("hidden");
  disclaimerNote.classList.remove("hidden");

  try {
    // 1. Fetch data (will use cache if available and fresh)
    const { allRawPrices, statusMessage, isCached } =
      await checkCacheAndFetchPrices(zone);

    // Show status message after fetching/checking
    dataStatusBox.innerHTML = statusMessage;
    dataStatusBox.classList.remove(
      "hidden",
      "bg-red-100",
      "bg-yellow-100",
      "bg-green-100",
      "bg-green-200",
      "text-red-800",
      "text-yellow-800",
      "text-green-800"
    );
    dataStatusBox.classList.add(
      isCached ? "bg-green-200" : "bg-green-100",
      "text-green-800"
    );

    if (allRawPrices.length === 0) {
      messageBox.innerHTML =
        '<p class="text-red-600 font-bold">Could not load any price data for today or tomorrow. Check the status box above for details.</p>';
      dataStatusBox.classList.remove("bg-green-100", "bg-green-200");
      dataStatusBox.classList.add("bg-red-100", "text-red-800");
      chartContainer.classList.add("hidden");
      return;
    }

    // 2. Parse data and apply user fees
    const allPrices = parsePriceData(allRawPrices, userFees);

    // 3. Filter prices: Must be in the future AND within the selected time window
    const availablePrices =
      allPrices ||
      allPrices.filter((p) => {
        if (p.isPast) return false;

        const priceHour = p.timestamp.getHours();
        if (startHour !== 0 || endHour !== 24) {
          return priceHour >= startHour && priceHour < endHour;
        }
        return true;
      });
    const totalSlotsAvailable = availablePrices.length;
    const totalMinutesAvailable = totalSlotsAvailable * 15;
    const hoursNeeded = minutesNeeded / 60;
    if (totalMinutesAvailable < minutesNeeded) {
      messageBox.innerHTML = `
                        <p class="text-red-600 font-bold">
                            ⚠️ Not enough future periods available (${minutesNeeded} minutes needed, but only ${totalMinutesAvailable} available in the selected window).
                        </p>
                        <p class="text-gray-500 mt-2 text-sm">
                            Try reducing the duration or widening the search window.
                        </p>
                    `;
      chartContainer.classList.add("hidden");
      return;
    }

    // 4. Find the top N non-overlapping slots (Greedy Strategy)
    const results = findTopBestTimeSlots(
      availablePrices,
      hoursNeeded,
      topSlotsNeeded
    );

    // Store results globally for the LLM assistant
    lastCalculatedSlots = results;
    lastCalculatedUserFees = userFees;

    if (results.length === 0) {
      messageBox.innerHTML =
        '<p class="text-red-600 font-bold">Could not find any suitable continuous time block matching your criteria.</p>';
      chartContainer.classList.add("hidden");
    } else {
      messageBox.innerHTML = `
                        <p class="mb-3 text-green-700 text-lg font-bold">✅ Found ${
                          results.length
                        } Best Non-Overlapping Time Slot${
        results.length !== 1 ? "s" : ""
      }!</p>
                        <p class="text-gray-600">Calculated across the next ${totalSlotsAvailable.toFixed(
                          1
                        )} hours of available data using your custom fees.</p>
                    `;
      // 5. Render Chart
      renderPriceChart(allPrices, results);

      // 6. Render Detailed Slots
      results.forEach((slot) => {
        slotResultsContainer.innerHTML += renderSlot(slot);
      });

      // 7. Show LLM Assistant
      //   strategyGeneratorContainer.classList.remove("hidden");
      //   strategyOutput.innerHTML =
      //     "Enter your tasks above and click the button for an optimized schedule!";
    }

    // Scroll to results
    setTimeout(() => {
      chartContainer.scrollIntoView({ behavior: "smooth" });
    }, 100);
  } catch (error) {
    console.error("Calculation Error:", error);
    dataStatusBox.classList.remove("bg-green-100", "bg-green-200");
    dataStatusBox.classList.add("bg-red-100", "text-red-800");
    dataStatusBox.innerHTML = `❌ Data Error: Check console for full details.`;
    messageBox.innerHTML = `<p class="text-red-600 font-bold">A critical error occurred during price processing. See Data Status box for error details.</p>`;
    chartContainer.classList.add("hidden");
  } finally {
    // End loading state
    calculateButton.disabled = false;
    loadingSpinner.classList.add("hidden");
  }
}

// --- Initialization ---
document.addEventListener("DOMContentLoaded", () => {
  strategyGeneratorContainer.classList.add("hidden");
  updateCurrentTime();
  setInterval(updateCurrentTime, 1000);

  // Load user preferences from localStorage if available
  try {
    const defaultPreferences = {
      zone: "SE4",
      minutesNeeded: "60",
      topSlotsNeeded: "4",
      timeSlot: "0-24",
      gridFee: "0",
      energyTax: "0",
      vatPercentage: "0",
    };
    const prefsStr =
      localStorage.getItem("userPreferences") ||
      JSON.stringify(defaultPreferences);
    if (prefsStr) {
      const prefs = JSON.parse(prefsStr);
      priceZoneSelect.value = prefs.zone;
      minutesNeededInput.value = prefs.minutesNeeded;
      topSlotsNeededInput.value = prefs.topSlotsNeeded;
      timeSlotSelect.value = prefs.timeSlot;
      gridFeeInput.value = prefs.gridFee;
      energyTaxInput.value = prefs.energyTax;
      vatPercentageInput.value = prefs.vatPercentage;
    }
  } catch (e) {
    console.error("Error loading user preferences:", e);
  }

  calculateButton.addEventListener("click", handleCalculate);
  generateStrategyButton.addEventListener("click", handleStrategyGeneration);
});
