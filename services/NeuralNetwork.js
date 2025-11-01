// file: services/NeuralNetwork.js
// Đây là một mạng Neural đơn giản bằng Javascript thuần, không cần thư viện
class NeuralNetwork {
    constructor(inputNodes, hiddenNodes, outputNodes) {
        this.inputNodes = inputNodes;
        this.hiddenNodes = hiddenNodes;
        this.outputNodes = outputNodes;

        this.weights_ih = this.createMatrix(this.hiddenNodes, this.inputNodes);
        this.weights_ho = this.createMatrix(this.outputNodes, this.hiddenNodes);
        this.bias_h = this.createMatrix(this.hiddenNodes, 1);
        this.bias_o = this.createMatrix(this.outputNodes, 1);

        this.randomize();
        this.learningRate = 0.01;
    }

    createMatrix(rows, cols) { return Array(rows).fill(0).map(() => Array(cols).fill(0)); }
    randomize() {
        this.weights_ih = this.weights_ih.map(row => row.map(() => Math.random() * 2 - 1));
        this.weights_ho = this.weights_ho.map(row => row.map(() => Math.random() * 2 - 1));
        this.bias_h = this.bias_h.map(row => row.map(() => Math.random() * 2 - 1));
        this.bias_o = this.bias_o.map(row => row.map(() => Math.random() * 2 - 1));
    }
    sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
    dsigmoid(y) { return y * (1 - y); }
    
    static fromJson(data) {
        const nn = new NeuralNetwork(data.inputNodes, data.hiddenNodes, data.outputNodes);
        nn.weights_ih = data.weights_ih;
        nn.weights_ho = data.weights_ho;
        nn.bias_h = data.bias_h;
        nn.bias_o = data.bias_o;
        nn.learningRate = data.learningRate;
        return nn;
    }

    predict(inputArray) {
        const inputs = this.arrayToMatrix(inputArray);
        const hidden = this.multiply(this.weights_ih, inputs);
        hidden.forEach((row, i) => row.forEach((_, j) => hidden[i][j] += this.bias_h[i][j]));
        hidden.forEach((row, i) => row.forEach((val, j) => hidden[i][j] = this.sigmoid(val)));

        const output = this.multiply(this.weights_ho, hidden);
        output.forEach((row, i) => row.forEach((_, j) => output[i][j] += this.bias_o[i][j]));
        output.forEach((row, i) => row.forEach((val, j) => output[i][j] = this.sigmoid(val)));
        
        return this.matrixToArray(output);
    }
    
    train(inputArray, targetArray) {
        const inputs = this.arrayToMatrix(inputArray);
        const hidden = this.multiply(this.weights_ih, inputs);
        hidden.forEach((r,i) => r.forEach((_,j) => hidden[i][j] += this.bias_h[i][j]));
        hidden.forEach((r,i) => r.forEach((v,j) => hidden[i][j] = this.sigmoid(v)));

        const outputs = this.multiply(this.weights_ho, hidden);
        outputs.forEach((r,i) => r.forEach((_,j) => outputs[i][j] += this.bias_o[i][j]));
        outputs.forEach((r,i) => r.forEach((v,j) => outputs[i][j] = this.sigmoid(v)));

        const targets = this.arrayToMatrix(targetArray);
        const output_errors = this.subtract(targets, outputs);

        const gradients = outputs.map(r=>r.slice());
        gradients.forEach((r,i) => r.forEach((v,j) => gradients[i][j] = this.dsigmoid(v)));
        gradients.forEach((r,i) => r.forEach((v,j) => gradients[i][j] *= output_errors[i][j]));
        gradients.forEach(r => r.forEach((v,i) => r[i] *= this.learningRate));
        
        const hidden_T = this.transpose(hidden);
        const weight_ho_deltas = this.multiply(gradients, hidden_T);

        this.weights_ho.forEach((r, i) => r.forEach((_, j) => this.weights_ho[i][j] += weight_ho_deltas[i][j]));
        this.bias_o.forEach((r, i) => r.forEach((_, j) => this.bias_o[i][j] += gradients[i][j]));

        const who_t = this.transpose(this.weights_ho);
        const hidden_errors = this.multiply(who_t, output_errors);

        const hidden_gradient = hidden.map(r=>r.slice());
        hidden_gradient.forEach((r,i) => r.forEach((v,j) => hidden_gradient[i][j] = this.dsigmoid(v)));
        hidden_gradient.forEach((r,i) => r.forEach((v,j) => hidden_gradient[i][j] *= hidden_errors[i][j]));
        hidden_gradient.forEach(r => r.forEach((v,i) => r[i] *= this.learningRate));

        const inputs_T = this.transpose(inputs);
        const weight_ih_deltas = this.multiply(hidden_gradient, inputs_T);

        this.weights_ih.forEach((r, i) => r.forEach((_, j) => this.weights_ih[i][j] += weight_ih_deltas[i][j]));
        this.bias_h.forEach((r, i) => r.forEach((_, j) => this.bias_h[i][j] += hidden_gradient[i][j]));
    }

    arrayToMatrix(arr) { return arr.map(e => [e]); }
    matrixToArray(matrix) { return matrix.flat(); }
    transpose(matrix) { return matrix[0].map((_, colIndex) => matrix.map(row => row[colIndex])); }
    multiply(a, b) { return a.map((row, i) => b[0].map((_, j) => row.reduce((sum, elm, k) => sum + (elm * b[k][j]), 0))); }
    subtract(a, b) { return a.map((row, i) => row.map((val, j) => val - b[i][j])); }
}
module.exports = NeuralNetwork;
