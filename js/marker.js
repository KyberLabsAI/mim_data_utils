function numberToUpperCaseLetterString(number) {
  if (number <= 0) {
    return "";
  }

  let result = "";
  let temp = number - 1; // Adjust to 0-based indexing

  while (temp >= 0) {
    result = String.fromCharCode(65 + (temp % 26)) + result; // 65 is ASCII for 'A'
    temp = Math.floor(temp / 26) - 1;
  }

  return result;
}

/**
 * Represents a single marker with a label and a time value.
 */
class Mark {
    /**
     * @param {string} label - The label for the mark (e.g., '1', '2', '3').
     * @param {number} time - The time value associated with the mark.
     */
    constructor(label, time) {
      if (typeof label !== 'string' || label.trim() === '') {
        throw new Error('Mark label must be a non-empty string.');
      }
      if (typeof time !== 'number' || isNaN(time)) {
        throw new Error('Mark time must be a number.');
      }

      this.label = label;
      this.time = time;
    }

    /**
     * Returns a string representation of the Mark.
     * @returns {string}
     */
    toString() {
      return `Mark(label: '${this.label}', time: ${this.time})`;
    }
  }

/**
 * Manages a collection of Mark objects, assigning sequential labels.
 */
class Marks {
    constructor() {
      /**
       * @private
       * @type {Mark[]}
       */
      this.markers = [];
      /**
       * @private
       * @type {number}
       */
      this.markCounter = 1;
    }

    /**
     * Adds a new Mark to the collection. The label is an automatically incrementing number (as a string).
     * @param {number} time - The time value for the new mark.
     * @returns {Mark} The newly created Mark object.
     * @throws {Error} If the time is not a valid number.
     */
    addMark(time) {
      const label = numberToUpperCaseLetterString(this.markCounter);
      const newMark = new Mark(label, time); // Create an instance of the Mark class
      this.markers.push(newMark);
      this.markCounter++;
      return newMark;
    }

    /**
     * Returns an array of all stored Mark objects.
     * @returns {Mark[]} An array of Mark instances.
     */
    getMarks() {
      // Return a shallow copy to prevent external modification of the internal array
      return [...this.markers];
    }

    /**
     * Finds a Mark by its label.
     * @param {string} label - The label of the mark to find.
     * @returns {Mark | undefined} The Mark object if found, otherwise undefined.
     */
    findMarkByLabel(label) {
      return this.markers.find(marker => marker.label === label);
    }

    /**
     * Finds all Marks within a specified time range (inclusive).
     * @param {number} startTime - The start of the time range.
     * @param {number} endTime - The end of the time range.
     * @returns {Mark[]} An array of Mark instances within the range.
     */
    withinXLim(xlim) {
      const [minTime, maxTime] = xlim;
      return this.markers.filter(marker => marker.time >= minTime && marker.time <= maxTime);
    }

      /**
     * Removes a Mark from the collection based on its label.
     * @param {string} labelToRemove - The label of the mark to remove.
     */
    removeMarkByLabel(labelToRemove) {
        this.markers = this.markers.filter(marker => marker.label !== labelToRemove);
    }

    /**
     * Clears all stored marks and resets the counter.
     */
    clearMarks() {
      this.markers = [];
      this.markCounter = 1;
    }
  }
